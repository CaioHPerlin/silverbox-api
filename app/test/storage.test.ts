import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { LocalObjectStorage } from '../src/lib/storage.js'

test('storage refuses existing unsafe permissions instead of silently modifying them', async () => {
	const root = await mkdtemp(join(tmpdir(), 'silverbox-permissions-'))
	try {
		await chmod(root, 0o755)
		await assert.rejects(new LocalObjectStorage(root).init(), /permission/i)
		assert.equal((await stat(root)).mode & 0o777, 0o755)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('storage refuses symbolic links inside its private directory', async () => {
	const root = await mkdtemp(join(tmpdir(), 'silverbox-symlink-'))
	const outside = await mkdtemp(join(tmpdir(), 'silverbox-outside-'))
	try {
		await mkdir(join(root, 'objects'), { mode: 0o700 })
		await symlink(outside, join(root, 'staging'))
		await assert.rejects(new LocalObjectStorage(root).init(), /symbolic|symlink/i)
	} finally {
		await rm(root, { recursive: true, force: true })
		await rm(outside, { recursive: true, force: true })
	}
})

test('object operations refuse a symlinked user directory', async () => {
	const root = await mkdtemp(join(tmpdir(), 'silverbox-object-link-'))
	const outside = await mkdtemp(join(tmpdir(), 'silverbox-object-target-'))
	try {
		const store = new LocalObjectStorage(root)
		await store.init()
		await symlink(outside, join(root, 'objects', '1'))
		const key = `objects/1/${randomUUID()}`
		await assert.rejects(store.write(Readable.from('data'), key, 4n), /symbolic|symlink/i)
		await assert.rejects(store.read(key), /symbolic|symlink/i)
	} finally {
		await rm(root, { recursive: true, force: true })
		await rm(outside, { recursive: true, force: true })
	}
})
