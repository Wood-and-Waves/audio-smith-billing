// appendPdfs is the whole reason an original PDF receipt can ride the
// invoice at full fidelity rather than as the rasterized thumbnail — pure,
// no database, no clock.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendPdfs } from '../../lib/mergePdfAppendices.ts'

async function makePdf(pageCount: number): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  for (let i = 0; i < pageCount; i++) doc.addPage([200, 200])
  return doc.save()
}

async function pageCountOf(bytes: Uint8Array): Promise<number> {
  const { PDFDocument } = await import('pdf-lib')
  const doc = await PDFDocument.load(bytes)
  return doc.getPageCount()
}

test('every appendix page lands after the base', async () => {
  const base = await makePdf(1)
  const appendix = await makePdf(2)
  const merged = await appendPdfs(base, [appendix])
  assert.equal(await pageCountOf(merged), 3, 'the base page plus both appendix pages')
})

test('an empty appendices array leaves the base pages unchanged', async () => {
  const base = await makePdf(2)
  const merged = await appendPdfs(base, [])
  assert.equal(await pageCountOf(merged), 2)
})

test('a corrupt appendix is skipped, the base survives untouched', async () => {
  const base = await makePdf(1)
  const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
  const merged = await appendPdfs(base, [garbage])
  assert.equal(await pageCountOf(merged), 1, 'nothing from the garbage bytes was appended')
})

test('a corrupt appendix among good ones does not block the good ones', async () => {
  const base = await makePdf(1)
  const good = await makePdf(2)
  const garbage = new Uint8Array([9, 9, 9])
  const merged = await appendPdfs(base, [garbage, good])
  assert.equal(await pageCountOf(merged), 3,
    'the base plus the good appendix — the garbage one contributed nothing, but did not stop the rest')
})
