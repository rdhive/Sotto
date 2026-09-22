'use strict'
// Correctness checks for the correction pass. Run: node _test-dictionary.js
const os = require('os')
const fs = require('fs')
const path = require('path')
const { Dictionary, assessRisk } = require('./dictionary')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sotto-dict-'))
const dict = new Dictionary(dir)
dict.load()

dict.add({ type: 'correction', from: 'cloud code', to: 'Claude Code' })
dict.add({ type: 'correction', from: 'anthropic', to: 'Anthropic' })
dict.add({ type: 'correction', from: 'super base', to: 'Supabase' })
dict.add({ type: 'correction', from: 'versel', to: 'Vercel' })
dict.add({ type: 'correction', from: 'cloud code studio', to: 'Claude Code Studio' })
dict.add({ type: 'term', term: 'Redouan' })

let pass = 0, fail = 0
function check (input, expected, why) {
  const got = dict.apply(input).text
  const ok = got === expected
  ok ? pass++ : fail++
  console.log(
    `${ok ? '  ok  ' : 'FAIL  '}${why}\n        in  ${JSON.stringify(input)}` +
    `\n        out ${JSON.stringify(got)}` +
    (ok ? '' : `\n        want ${JSON.stringify(expected)}`)
  )
}

console.log('\n--- glued and hyphenated forms ---')
check('open cloud code now', 'open Claude Code now', 'spaced form')
check('open CloudCode now', 'open Claude Code now', 'glued form')
check('open Cloud-Code now', 'open Claude Code now', 'hyphenated form')
check('open cloudcode now', 'open Claude Code now', 'glued lowercase')
check('open CLOUD CODE now', 'open Claude Code now', 'shouty form')

console.log('\n--- must not corrupt real words ---')
check('we use Cloudflare here', 'we use Cloudflare here', 'Cloudflare untouched')
check('the cloud is fine', 'the cloud is fine', 'bare "cloud" untouched')
check('he is a cloud coder', 'he is a cloud coder', '"coder" blocks the match')
check('cloudcodex', 'cloudcodex', 'no trailing boundary')
check('precloudcode', 'precloudcode', 'no leading boundary')

console.log('\n--- longest match wins ---')
check('open cloud code studio', 'open Claude Code Studio', 'longer entry beats shorter')

console.log('\n--- other entries ---')
check('I work at anthropic', 'I work at Anthropic', 'single word')
check('deploy to versel with super base',
      'deploy to Vercel with Supabase', 'two entries in one sentence')
check('already Claude Code', 'already Claude Code', 'already-correct text is left alone')

console.log('\n--- reporting ---')
const r = dict.apply('push cloudcode to versel')
console.log('  text   :', JSON.stringify(r.text))
console.log('  applied:', r.applied.map(a => `${a.from} -> ${a.to} @${a.at}`).join(', '))
if (r.applied.length === 2) { pass++; console.log('  ok   both corrections reported') }
else { fail++; console.log('FAIL  expected 2 reported, got ' + r.applied.length) }

console.log('\n--- bias list ---')
const bias = dict.biasTerms()
console.log('  terms:', bias.join(', '))
if (bias.includes('Claude Code') && bias.includes('Redouan')) { pass++; console.log('  ok   uses the corrected spelling, includes plain terms') }
else { fail++; console.log('FAIL  bias list wrong') }

console.log('\n--- risk warnings ---')
for (const [w, want] of [['code', 'warn'], ['de', 'error'], ['cloud code', null],
                         ['Anthropic', null], ['xy', 'error'], ['the', 'warn']]) {
  const got = assessRisk(w)
  const level = got ? got.level : null
  const ok = level === want
  ok ? pass++ : fail++
  console.log(`${ok ? '  ok  ' : 'FAIL  '}"${w}" -> ${level}${got ? ': ' + got.message : ''}`)
}

console.log('\n--- persistence + hand-edit safety ---')
const raw = JSON.parse(fs.readFileSync(dict.path, 'utf8'))
console.log('  entries on disk:', raw.entries.length)
// Simulate someone editing the file by hand while the app holds a stale copy.
raw.entries.push({ id: 'handmade', type: 'term', term: 'Nakamichi', updatedAt: new Date().toISOString() })
fs.writeFileSync(dict.path, JSON.stringify(raw, null, 2))
dict.add({ type: 'term', term: 'FromApp' })
const after = JSON.parse(fs.readFileSync(dict.path, 'utf8')).entries.map(e => e.term || e.from)
const kept = after.includes('Nakamichi') && after.includes('FromApp')
kept ? pass++ : fail++
console.log(`${kept ? '  ok  ' : 'FAIL  '}hand edit survived a subsequent app write`)

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
