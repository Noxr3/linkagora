#!/usr/bin/env node
import { processIo, run } from './main.ts'

run(processIo(process.argv.slice(2))).then((code) => {
  process.exitCode = code
})
