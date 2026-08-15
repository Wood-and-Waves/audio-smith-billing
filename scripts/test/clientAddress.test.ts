// Streamline Pictures carried "10700 75th St" / "Elgin, IL 60123" as
// address_line1/address_line2 — real data. Once city/state/postal_code exist
// as their own columns, a hand-edit that clears line 2 and fills the new
// fields must not silently drop the city/state/ZIP from every invoice after
// that edit. This is the pure assembly the fix depends on; see
// app/invoices/actions.ts, components/InvoiceDocument.tsx and
// lib/invoicePdf.ts for the three call sites that must all agree with it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cityStateZip, billToLines, billToText } from '../../lib/clientAddress.ts'

test('cityStateZip joins city, state and ZIP when all three are present', () => {
  assert.equal(cityStateZip({ city: 'Elgin', state: 'IL', postal_code: '60123' }), 'Elgin, IL 60123')
})

test('cityStateZip prints only the city when state and ZIP are blank', () => {
  assert.equal(cityStateZip({ city: 'Elgin', state: null, postal_code: null }), 'Elgin')
  assert.equal(cityStateZip({ city: 'Elgin', state: '', postal_code: '' }), 'Elgin')
})

test('cityStateZip prints only the ZIP when city and state are blank', () => {
  assert.equal(cityStateZip({ city: null, state: null, postal_code: '60123' }), '60123')
})

test('cityStateZip is null when city, state and ZIP are all blank', () => {
  assert.equal(cityStateZip({ city: null, state: null, postal_code: null }), null)
  assert.equal(cityStateZip({ city: '', state: '  ', postal_code: undefined }), null)
})

test('cityStateZip joins state and ZIP with a space, not a comma, when city is blank', () => {
  assert.equal(cityStateZip({ city: null, state: 'IL', postal_code: '60123' }), 'IL 60123')
})

test('billToLines appends city/state/ZIP as its own line after the free-text address', () => {
  assert.deepEqual(
    billToLines({
      name: 'Streamline Pictures',
      address_line1: '10700 75th St',
      address_line2: null,
      city: 'Elgin',
      state: 'IL',
      postal_code: '60123',
    }),
    ['Streamline Pictures', '10700 75th St', 'Elgin, IL 60123'],
  )
})

test('billToText omits the city/state/ZIP line entirely when all three are blank', () => {
  assert.equal(
    billToText({ name: 'Journey Church', address_line1: null, address_line2: null }),
    'Journey Church',
  )
})
