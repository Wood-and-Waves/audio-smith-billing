-- 0011 — receipts may arrive as PDFs
--
-- 0010 whitelisted only image/jpeg and image/png, on the assumption that a
-- receipt is photographed. Half of them are not: airlines, hotels and Amazon
-- email a PDF, and that is the receipt Dan has. Uploading one was rejected by
-- storage before the app ever saw it.
--
-- The ENHANCED copy stays a JPEG — the browser rasterises the PDF's first page
-- so it can be embedded in the invoice, which @react-pdf cannot do with a PDF.
-- This widening is for the ORIGINAL, which is kept byte-for-byte as sent.
--
-- The size ceiling is unchanged at 10MB.
update storage.buckets
   set allowed_mime_types = array['image/jpeg', 'image/png', 'application/pdf']
 where id = 'receipts';
