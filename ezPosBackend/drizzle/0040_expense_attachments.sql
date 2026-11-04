-- 0040: Expense attachments — receipt/invoice metadata for files stored in
-- object storage (presigned PUT browser → MinIO/R2/S3; bytes never proxied
-- through the API).
--
-- objectKey layout: `businesses/{businessId}/expenses/{uuid}.{ext}` — the
-- per-business prefix is the storage-isolation boundary. Unlike storefront
-- media these documents are PRIVATE: downloads only ever happen through
-- short-lived presigned GET URLs issued after an ownership check.
--
-- Deletion is a soft delete (deleted_at) + audit entry so financial records
-- keep their provenance; the storage object is retained (access is revoked
-- by the row delete, since every download re-checks ownership).

CREATE TABLE expense_attachments (
    id SERIAL PRIMARY KEY,
    business_id integer NOT NULL REFERENCES businesses (id),
    expense_id integer NOT NULL,
    object_key varchar(300) NOT NULL,
    file_name varchar(255) NOT NULL,
    content_type varchar(100) NOT NULL,
    bytes bigint NOT NULL,
    uploaded_by integer,
    deleted_at timestamp,
    deleted_by integer,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT expense_attachments_bytes_positive_check CHECK (bytes > (0)::bigint)
);

ALTER TABLE expense_attachments ADD CONSTRAINT expense_attachments_expense_business_fkey FOREIGN KEY (expense_id, business_id) REFERENCES expenses (id, business_id);
ALTER TABLE expense_attachments ADD CONSTRAINT expense_attachments_uploaded_by_users_fk FOREIGN KEY (uploaded_by) REFERENCES users (id);
ALTER TABLE expense_attachments ADD CONSTRAINT expense_attachments_deleted_by_users_fk FOREIGN KEY (deleted_by) REFERENCES users (id);

CREATE UNIQUE INDEX expense_attachments_object_key_unique ON expense_attachments (object_key);
CREATE INDEX expense_attachments_expense_idx ON expense_attachments (expense_id);
CREATE INDEX expense_attachments_business_idx ON expense_attachments (business_id);
