import { parseRecord } from './parse.js'
import { buildReport } from './report.js'

console.log(buildReport(['1,alice,10']), parseRecord('2,bob,5'))
