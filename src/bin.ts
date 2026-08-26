#!/usr/bin/env node

import { runDaykeeperCli } from "./command.js";

process.exitCode = await runDaykeeperCli({ argv: process.argv.slice(2) });
