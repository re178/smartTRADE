#!/usr/bin/env node
/**
 * wipeDatabase.js — Completely empty the connected MongoDB database.
 *
 * Modes:
 *   --mode=collections  (default) drop every collection  -> DB is empty, indexes gone
 *   --mode=documents              delete all documents    -> collections/indexes kept
 *   --mode=database               db.dropDatabase()       -> also removes db-level users/roles
 *
 * Options:
 *   --dry-run            show what would be deleted, delete nothing
 *   --keep=a,b,c         never touch these collections
 *   --yes, -y            skip the confirmation prompt (DANGEROUS, for scripts/CI)
 *   --include-system     also touch system.* collections (almost never needed)
 *   --help, -h           show help
 *
 * Examples:
 *   node wipeDatabase.js --dry-run
 *   node wipeDatabase.js --keep=users,sessions
 *   node wipeDatabase.js --mode=documents
 *   node wipeDatabase.js --yes
 */

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const readline = require('readline');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/rts';

/* ------------------------------------------------------------------ */
/* CLI parsing                                                        */
/* ------------------------------------------------------------------ */

function printHelp() {
  console.log(`
Usage: node wipeDatabase.js [options]

  --mode=collections|documents|database   what to wipe (default: collections)
  --dry-run                               show what would be deleted
  --keep=a,b,c                            collections to leave untouched
  --yes, -y                               skip confirmation prompt
  --include-system                        also process system.* collections
  --help, -h                              show this help

Connection string comes from MONGODB_URI in .env
(currently: ${MONGODB_URI.replace(/\/\/[^@]*@/, '//***:***@')})
`);
}

function parseArgs(argv) {
  const opts = {
    mode: 'collections',
    dryRun: false,
    yes: false,
    includeSystem: false,
    keep: new Set(),
  };

  for (const raw of argv) {
    const idx = raw.indexOf('=');
    const flag = idx === -1 ? raw : raw.slice(0, idx);
    const value = idx === -1 ? '' : raw.slice(idx + 1);

    switch (flag) {
      case '--mode':
        opts.mode = value;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--yes':
      case '-y':
        opts.yes = true;
        break;
      case '--include-system':
        opts.includeSystem = true;
        break;
      case '--keep':
        value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((n) => opts.keep.add(n));
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        console.warn(`⚠️  Unknown argument ignored: ${raw}`);
    }
  }

  if (!['collections', 'documents', 'database'].includes(opts.mode)) {
    console.error(`❌ Invalid --mode "${opts.mode}". Use collections | documents | database.`);
    process.exit(1);
  }

  if (opts.mode === 'database' && opts.keep.size > 0) {
    console.error('❌ --keep cannot be used with --mode=database (whole DB is dropped).');
    process.exit(1);
  }

  return opts;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const isSystemCollection = (name) => name.startsWith('system.');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => {
    rl.close();
    resolve(ans);
  }));
}

async function safeCount(db, name, type) {
  if (type === 'view') return 'view';
  try {
    return await db.collection(name).estimatedDocumentCount();
  } catch {
    return '?';
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  const db = mongoose.connection.db;
  const dbName = db.databaseName;
  console.log(`✅ Connected to database: "${dbName}"\n`);

  /* ---- 1. Discover what exists ---- */
  const infos = await db.listCollections({}, { nameOnly: false }).toArray();

  const allTargets = infos.filter((c) => {
    if (!opts.includeSystem && isSystemCollection(c.name)) return false;
    if (opts.keep.has(c.name)) return false;
    return true;
  });

  const kept = infos
    .map((c) => c.name)
    .filter((n) => opts.keep.has(n) || (!opts.includeSystem && isSystemCollection(n)));

  if (allTargets.length === 0) {
    console.log('ℹ️  Nothing to delete — the database is already empty (of target collections).');
    if (kept.length) console.log(`   Kept: ${kept.join(', ')}`);
    await mongoose.disconnect();
    return;
  }

  /* ---- 2. Preview ---- */
  console.log(`🗂️  Collections targeted (mode = ${opts.mode}):`);
  let totalDocs = 0;
  for (const c of allTargets) {
    const count = await safeCount(db, c.name, c.type);
    if (typeof count === 'number') totalDocs += count;
    const tag = c.type === 'view' ? ' [view]' : c.type === 'timeseries' ? ' [timeseries]' : '';
    console.log(`   - ${c.name}${tag}  (${count} docs)`);
  }
  if (typeof totalDocs === 'number') {
    console.log(`\n   Total documents in scope: ${totalDocs}`);
  }
  if (kept.length) {
    console.log(`   Preserved: ${kept.join(', ')}`);
  }

  console.log('\n⚠️  THIS IS DESTRUCTIVE AND CANNOT BE UNDONE.');
  console.log('   Take a backup first if you may need this data:');
  console.log(`   mongodump --uri="${MONGODB_URI}" --out=./backup-$(date +%Y%m%d-%H%M%S)\n`);

  if (opts.dryRun) {
    console.log('🧪 Dry run — nothing was deleted.');
    await mongoose.disconnect();
    return;
  }

  /* ---- 3. Confirm ---- */
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      console.error('❌ Non-interactive terminal. Re-run with --yes if you really mean it.');
      await mongoose.disconnect();
      process.exit(1);
    }
    const answer = await ask(`Type the database name "${dbName}" to confirm: `);
    if (answer.trim() !== dbName) {
      console.log('❌ Aborted — nothing was deleted.');
      await mongoose.disconnect();
      process.exit(0);
    }
  }

  /* ---- 4. Wipe ---- */
  console.log('\n🗑️  Deleting...\n');
  let dropped = 0;
  let failed = 0;
  let deletedDocs = 0;

  if (opts.mode === 'database') {
    try {
      await db.dropDatabase();
      dropped = allTargets.length;
      console.log(`✅ Dropped entire database "${dbName}".`);
    } catch (err) {
      failed++;
      console.error(`❌ dropDatabase failed: ${err.message}`);
    }
  } else if (opts.mode === 'collections') {
    for (const c of allTargets) {
      try {
        await db.dropCollection(c.name);
        dropped++;
        console.log(`   ✅ dropped  ${c.name}`);
      } catch (err) {
        if (err.code === 26 /* NamespaceNotFound */) {
          console.log(`   ℹ️  skipped  ${c.name} (already gone)`);
        } else {
          failed++;
          console.error(`   ❌ failed   ${c.name}: ${err.message}`);
        }
      }
    }
  } else {
    // documents mode
    for (const c of allTargets) {
      if (c.type === 'view') {
        console.log(`   ℹ️  skipped  ${c.name} (view — use --mode=collections to drop it)`);
        continue;
      }
      try {
        const res = await db.collection(c.name).deleteMany({});
        deletedDocs += res.deletedCount || 0;
        console.log(`   ✅ emptied  ${c.name}  (${res.deletedCount} docs removed)`);
      } catch (err) {
        failed++;
        console.error(`   ❌ failed   ${c.name}: ${err.message}`);
      }
    }
  }

  /* ---- 5. Verify ---- */
  const remaining = await db.listCollections({}, { nameOnly: true }).toArray();
  const remainingNames = remaining.map((c) => c.name);

  console.log('\n──────────────────────────────────────────────');
  console.log(`📊 Summary`);
  console.log(`   Mode:              ${opts.mode}`);
  if (opts.mode === 'documents') {
    console.log(`   Documents deleted: ${deletedDocs}`);
  } else {
    console.log(`   Collections dropped: ${dropped}`);
  }
  console.log(`   Failures:          ${failed}`);
  console.log(`   Remaining in DB:   ${remainingNames.length === 0 ? '(none — database is empty)' : remainingNames.join(', ')}`);
  console.log('──────────────────────────────────────────────\n');

  console.log('📌 Database is clean. Start your EA / app to re-import fresh data.');

  await mongoose.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('❌ Fatal error:', err.message);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
