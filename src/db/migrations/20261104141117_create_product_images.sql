-- Product photos. The file is in R2 or S3; this row records where. Hard deleted: no history is needed.

CREATE TYPE storage_provider AS ENUM ('r2', 's3');

CREATE TABLE product_images (
  id                UUID             PRIMARY KEY DEFAULT uuidv7(),
  product_id        UUID             NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  variant_id        UUID,                       -- set for images of one colour

  storage_provider  storage_provider NOT NULL,  -- so deleting still works after switching providers
  storage_key       VARCHAR(255)     NOT NULL,  -- file path in the bucket
  url               TEXT             NOT NULL,  -- public address customers load
  alt_text          VARCHAR(200),

  sort_order        INTEGER          NOT NULL DEFAULT 0,
  is_primary        BOOLEAN          NOT NULL DEFAULT FALSE,

  created_at        TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ      NOT NULL DEFAULT NOW(),

  -- Keeps an image's variant within the same product. Deleting the variant keeps the image.
  FOREIGN KEY (variant_id, product_id) REFERENCES product_variants (id, product_id) ON DELETE SET NULL (variant_id),

  -- One uploaded file can't be attached twice
  CONSTRAINT product_images_storage_unique UNIQUE (storage_provider, storage_key)
);

CREATE UNIQUE INDEX product_images_one_primary ON product_images (product_id) WHERE is_primary;
CREATE INDEX product_images_product_order_idx ON product_images (product_id, sort_order);
CREATE INDEX product_images_variant_id_idx ON product_images (variant_id) WHERE variant_id IS NOT NULL;

CREATE TRIGGER product_images_set_updated_at
BEFORE UPDATE ON product_images
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
