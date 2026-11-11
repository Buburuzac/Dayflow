-- Windows cards use Unix seconds; older integrations also send milliseconds.
-- Only seconds-based rows were undercounted by the previous projection.
UPDATE project_entries e
   SET minutes = GREATEST(0, c.end_ts - c.start_ts) / 60.0
       * LEAST(1, GREATEST(0, cp.share))
       * CASE WHEN (
           SELECT SUM(LEAST(1, GREATEST(0, x.share)))
             FROM card_projects x
            WHERE x.card_id = c.id AND x.user_id = c.user_id AND x.confirmed AND NOT x.deleted
         ) > 1
         THEN 1 / (
           SELECT SUM(LEAST(1, GREATEST(0, x.share)))
             FROM card_projects x
            WHERE x.card_id = c.id AND x.user_id = c.user_id AND x.confirmed AND NOT x.deleted
         ) ELSE 1 END,
       updated_at = now()
  FROM cards c, card_projects cp
 WHERE e.card_id = c.id AND e.project_id = cp.project_id AND cp.card_id = c.id
   AND cp.user_id = c.user_id AND cp.confirmed AND NOT cp.deleted
   AND c.start_ts < 100000000000;
