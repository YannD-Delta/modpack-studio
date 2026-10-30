-- Blacklist rows that are not derived from the base pack are the user's own entries; their role is 'user' now.
UPDATE `blacklist` SET `origin` = 'user' WHERE `origin` <> 'atm_derived';
