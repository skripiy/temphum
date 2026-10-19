#!/usr/bin/env node
// Регистрирует датчик и печатает его токен (в БД хранится только sha256).
//   node scripts/add-device.mjs bathroom "Ванная" [sort] [--outdoor] [--local]
import { randomBytes, createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';

const args = process.argv.slice(2);
const local = args.includes('--local');
const outdoor = args.includes('--outdoor') ? 1 : 0;
const [id, name, sort = '0'] = args.filter((a) => !a.startsWith('--'));

if (!id || !name || !/^[a-z0-9_-]{1,32}$/.test(id) || !/^\d+$/.test(sort)) {
  console.error('Usage: node scripts/add-device.mjs <id: a-z0-9_-> "<Название>" [sort] [--outdoor] [--local]');
  process.exit(1);
}

const token = randomBytes(24).toString('base64url');
const hash = createHash('sha256').update(token).digest('hex');
const sqlName = name.replace(/'/g, "''");
const sql = `INSERT INTO devices (id, name, sort, outdoor, token_hash) VALUES ('${id}', '${sqlName}', ${sort}, ${outdoor}, '${hash}')
  ON CONFLICT(id) DO UPDATE SET name = excluded.name, sort = excluded.sort, outdoor = excluded.outdoor,
    token_hash = excluded.token_hash;`;

// SQL идёт через файл, а не аргументом командной строки: так одинаково работает в PowerShell/cmd/bash
// и не ломаются кавычки и кириллица в названии.
const sqlFile = '.add-device.sql';
writeFileSync(sqlFile, sql, 'utf8');
try {
  execSync(`npx wrangler d1 execute climate ${local ? '--local' : '--remote'} --yes --file=${sqlFile}`, {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
} finally {
  rmSync(sqlFile, { force: true });
}

console.log(`\nУстройство "${id}" (${name}) зарегистрировано.`);
console.log(`DEVICE_TOKEN: ${token}`);
console.log('Вставьте токен в firmware/climate_node/config.h. Повторный запуск выпустит новый токен, старый перестанет работать.');
