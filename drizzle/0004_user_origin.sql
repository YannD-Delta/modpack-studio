-- The blacklist origin of the user's own entries was stored under the maintainer's first name; it is a role now.
UPDATE `blacklist` SET `origin` = 'user' WHERE `origin` = 'yann';
