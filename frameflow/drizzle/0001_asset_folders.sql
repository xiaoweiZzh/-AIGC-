CREATE TABLE IF NOT EXISTS asset_folders (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE,
  UNIQUE(owner, name)
);
--> statement-breakpoint
ALTER TABLE assets ADD COLUMN folder TEXT REFERENCES asset_folders(id);
--> statement-breakpoint
UPDATE assets SET archived=1 WHERE folder IS NULL AND mime='image/jpeg' AND (
  (name='雨夜霓虹（示例）' AND category='场景' AND size=127847) OR
  (name='海岸旅人（示例）' AND category='角色' AND size=73506) OR
  (name='晨雾森林（示例）' AND category='风格' AND size=144114) OR
  (name='银色跑车（示例）' AND category='道具' AND size=83856)
);
