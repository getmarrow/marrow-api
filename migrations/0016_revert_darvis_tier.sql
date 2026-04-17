-- 0016: Revert Darvis account to free for tier gate testing
UPDATE accounts SET tier = 'free' WHERE id = '58ac3364-469d-4553-9f9b-486d6cf37e9a';
