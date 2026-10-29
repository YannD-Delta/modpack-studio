import { integer, primaryKey, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

export const packVersion = sqliteTable(
  'pack_version',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    pack: text('pack').notNull(), // 'ATM10' | 'LMP'
    version: text('version').notNull(),
    mc: text('mc'),
    loader: text('loader'),
    loaderVersion: text('loader_version'),
    baseAtmVersion: text('base_atm_version'), // LMP only
    lmpHotfix: integer('lmp_hotfix'),
  },
  (t) => [unique().on(t.pack, t.version)],
);

export const profile = sqliteTable('profile', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  packVersionId: integer('pack_version_id')
    .notNull()
    .references(() => packVersion.id),
  side: text('side').notNull(), // 'client' | 'server'
  state: text('state').notNull(), // 'clean' | 'launched' | 'run'
  locationKind: text('location_kind').notNull(), // 'zip' | 'folder' | 'smb' | 'agent'
  location: text('location').notNull(),
  capturedAt: text('captured_at'),
  manifestHash: text('manifest_hash'),
  immutable: integer('immutable').notNull().default(0),
});

export const jar = sqliteTable('jar', {
  sha256: text('sha256').primaryKey(),
  filename: text('filename').notNull(),
  size: integer('size').notNull(),
});

export const jarMod = sqliteTable('jar_mod', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jarSha256: text('jar_sha256')
    .notNull()
    .references(() => jar.sha256),
  profileId: integer('profile_id')
    .notNull()
    .references(() => profile.id),
  modId: text('mod_id').notNull(),
  version: text('version').notNull(),
  declaredSide: text('declared_side').notNull().default('unknown'),
  isJij: integer('is_jij').notNull().default(0),
  parentJar: text('parent_jar'),
  libraryKey: text('library_key'),
});

export const importIssue = sqliteTable('import_issue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  profileId: integer('profile_id')
    .notNull()
    .references(() => profile.id),
  file: text('file').notNull(),
  reason: text('reason').notNull(),
});

export const modDecision = sqliteTable(
  'mod_decision',
  {
    modId: text('mod_id').notNull(),
    kind: text('kind').notNull(), // 'side' | 'pin' | 'ignore'
    side: text('side'),
    reason: text('reason').notNull().default(''),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.modId, t.kind] })],
);

export const blacklist = sqliteTable(
  'blacklist',
  {
    modId: text('mod_id').notNull(),
    origin: text('origin').notNull(), // 'atm_derived' | 'yann'
    validFor: text('valid_for'),
    reason: text('reason').notNull().default(''),
  },
  (t) => [primaryKey({ columns: [t.modId, t.origin] })],
);

export const blob = sqliteTable('blob', {
  sha256: text('sha256').primaryKey(),
  size: integer('size').notNull(),
  refs: integer('refs').notNull().default(0),
});

export const job = sqliteTable('job', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  params: text('params').notNull().default('null'),
  status: text('status').notNull(),
  progress: real('progress'),
  message: text('message'),
  lockKey: text('lock_key'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const setting = sqliteTable('setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: text('at').notNull(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  target: text('target'),
  detail: text('detail'),
});

export const event = sqliteTable('event', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: text('at').notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id').notNull(),
  action: text('action').notNull(),
  before: text('before'),
  after: text('after'),
});
