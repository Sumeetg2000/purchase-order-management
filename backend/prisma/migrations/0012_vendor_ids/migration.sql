-- Vendors take their id from the app, like every other table: a UUIDv7 (lib/uuid.ts), so
-- ids sort by creation and the primary key's btree appends instead of splitting at random.
-- 0011 defaulted to gen_random_uuid(); the default goes, so an insert that forgets the id
-- fails instead of quietly writing a v4. Runs as po_owner.

ALTER TABLE vendors ALTER COLUMN id DROP DEFAULT;
GRANT INSERT (id) ON vendors TO po_app;

-- The status index without id: name_key is unique (vendors_name_key_key), so it is already
-- a total order within a status, and the list sorts by name_key alone.
DROP INDEX vendors_status_name_key_idx;
CREATE INDEX vendors_status_name_key_idx ON vendors (status, name_key);
