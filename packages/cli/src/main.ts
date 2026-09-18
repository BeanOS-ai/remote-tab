#!/usr/bin/env bun
import { runCLI } from "./index";

process.exitCode = await runCLI(process.argv.slice(2));
