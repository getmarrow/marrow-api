import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '../types';
import welcomeTemplate from '../email-templates/welcome.json';
import day3NudgeTemplate from '../email-templates/day3_nudge.json';
import milestone100Template from '../email-templates/milestone_100.json';
import catchupV1Template from '../email-templates/catchup_v1.json';

type TemplateName = 'welcome' | 'day3_nudge' | 'milestone_100' | 'catchup_v1';

type TemplateVars = Record<string, string | number | null | undefined>;

interface EmailTemplateFile {
  subject: string;
  preheader: string;
  html: string;
  text: string;
}

const TEMPLATES: Record<TemplateName, EmailTemplateFile> = {
  welcome: welcomeTemplate,
  day3_nudge: day3NudgeTemplate,
  milestone_100: milestone100Template,
  catchup_v1: catchupV1Template,
};

export class EmailService {
  constructor(private db: D1Database, private env: Env) {}

  async canSendTemplate(accountId: string, templateName: TemplateName): Promise<{ ok: boolean; reason?: string }> {
    if (!this.env.RESEND_API_KEY) return { ok: false, reason: 'missing_resend_api_key' };

    const alreadySent = await this.db
      .prepare('SELECT id FROM emails_sent WHERE account_id = ? AND template_name = ? LIMIT 1')
      .bind(accountId, templateName)
      .first<{ id: string }>();
    if (alreadySent) return { ok: false, reason: 'already_sent' };

    const unsubscribed = await this.db
      .prepare("SELECT account_id FROM email_unsubscribes WHERE account_id = ? AND unsubscribed_at != '' LIMIT 1")
      .bind(accountId)
      .first<{ account_id: string }>();
    if (unsubscribed) return { ok: false, reason: 'unsubscribed' };

    const template = this.loadTemplate(templateName);
    if (!this.templateHasContent(template)) return { ok: false, reason: 'template_empty' };

    return { ok: true };
  }

  async sendTemplate(
    accountId: string,
    email: string,
    templateName: TemplateName,
    vars: TemplateVars
  ): Promise<{ success: boolean; message_id?: string; reason?: string }> {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) return { success: false, reason: 'missing_email' };

    try {
      const allowed = await this.canSendTemplate(accountId, templateName);
      if (!allowed.ok) return { success: true, reason: allowed.reason };

      const template = this.loadTemplate(templateName);

      const token = await this.generateUnsubscribeToken(accountId);
      const unsubscribeUrl = `${this.baseUrl()}/v1/email/unsubscribe?token=${encodeURIComponent(token)}`;
      const rendered = this.renderTemplate(template, {
        ...vars,
        email: normalizedEmail,
        unsubscribe_url: unsubscribeUrl,
      });

      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'Buu <buu@mail.getmarrow.ai>',
          to: normalizedEmail,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          reply_to: 'buu@getmarrow.ai',
          headers: {
            'List-Unsubscribe': `<mailto:buu@getmarrow.ai?subject=unsubscribe>, <${unsubscribeUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        }),
      });

      if (!resendRes.ok) {
        const detail = await resendRes.text().catch(() => '');
        console.error(`[email] resend ${templateName} failed:`, resendRes.status, detail);
        return { success: false, reason: `resend_${resendRes.status}` };
      }

      const payload = await resendRes.json().catch(() => ({})) as Record<string, unknown>;
      const payloadData = typeof payload.data === 'object' && payload.data
        ? (payload.data as Record<string, unknown>)
        : null;
      const messageId = typeof payload.id === 'string'
        ? payload.id
        : typeof payloadData?.id === 'string'
          ? String(payloadData.id)
          : undefined;

      try {
        await this.db
          .prepare('INSERT INTO emails_sent (id, account_id, template_name, sent_at, resend_message_id) VALUES (?, ?, ?, ?, ?)')
          .bind(crypto.randomUUID(), accountId, templateName, new Date().toISOString(), messageId || null)
          .run();
      } catch (insertErr) {
        const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
        if (msg.toLowerCase().includes('unique')) {
          return { success: true, message_id: messageId, reason: 'already_sent' };
        }
        console.error('[email] failed to persist emails_sent row:', insertErr);
        return { success: false, reason: 'persist_failed' };
      }

      return { success: true, message_id: messageId };
    } catch (error) {
      console.error(`[email] ${templateName} network error:`, error);
      return { success: false, reason: 'network_error' };
    }
  }

  async generateUnsubscribeToken(accountId: string): Promise<string> {
    const existing = await this.db
      .prepare('SELECT token FROM email_unsubscribes WHERE account_id = ? LIMIT 1')
      .bind(accountId)
      .first<{ token: string }>();
    if (existing?.token) return existing.token;

    const token = `${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    try {
      await this.db
        .prepare('INSERT INTO email_unsubscribes (account_id, unsubscribed_at, token) VALUES (?, ?, ?)')
        .bind(accountId, '', token)
        .run();
      return token;
    } catch (error) {
      const fallback = await this.db
        .prepare('SELECT token FROM email_unsubscribes WHERE account_id = ? LIMIT 1')
        .bind(accountId)
        .first<{ token: string }>();
      if (fallback?.token) return fallback.token;
      throw error;
    }
  }

  async unsubscribe(token: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT account_id FROM email_unsubscribes WHERE token = ? LIMIT 1')
      .bind(token)
      .first<{ account_id: string }>();
    if (!row?.account_id) return false;

    await this.db
      .prepare('UPDATE email_unsubscribes SET unsubscribed_at = ? WHERE token = ?')
      .bind(new Date().toISOString(), token)
      .run();
    return true;
  }

  private loadTemplate(templateName: TemplateName): EmailTemplateFile {
    return TEMPLATES[templateName];
  }

  private baseUrl(): string {
    return this.env.ENVIRONMENT === 'production'
      ? 'https://api.getmarrow.ai'
      : 'https://staging-api.getmarrow.ai';
  }

  private templateHasContent(template: EmailTemplateFile): boolean {
    const fields = [template.subject, template.preheader, template.html, template.text].map((v) => String(v || '').trim());
    const hasTodo = fields.some((v) => v.toUpperCase().includes('TODO'));
    const hasBody = Boolean(fields[2] || fields[3]);
    return Boolean(fields[0]) && hasBody && !hasTodo;
  }

  private renderTemplate(template: EmailTemplateFile, vars: TemplateVars): EmailTemplateFile {
    const subject = this.substitute(template.subject, vars);
    const preheader = this.substitute(template.preheader, vars);
    const htmlBody = this.substitute(template.html, vars);
    const text = this.substitute(template.text, vars);
    const html = preheader
      ? `${this.preheaderHtml(preheader)}${htmlBody}`
      : htmlBody;

    return { subject, preheader, html, text };
  }

  private substitute(input: string, vars: TemplateVars): string {
    let output = String(input || '');
    for (const [key, value] of Object.entries(vars)) {
      output = output.split(`{{${key}}}`).join(value == null ? '' : String(value));
    }
    return output;
  }

  private preheaderHtml(preheader: string): string {
    return `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</div>`;
  }
}
