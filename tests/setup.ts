/**
 * Vitest setup.
 *
 * Modules under test import the database client at load time, which would
 * otherwise create a real file on disk. An in-memory URL keeps unit tests from
 * touching the developer's actual database.
 */
process.env.DATABASE_URL ??= 'file::memory:';
process.env.OPENHAUL_KEYS ??= `v1:${Buffer.alloc(32, 7).toString('base64')}`;
process.env.OPENHAUL_INDEX_KEY_VERSION ??= '1';
