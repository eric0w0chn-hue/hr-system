'use strict';

// Isolated candidate. Wiring/deployment and the matching browser Rules migration
// are separate rollout steps. This module never loads credentials or initializes an SDK.
const {createHash} = require('node:crypto');
const SOURCE_DOCS = Object.freeze(['hr/employees', 'hr/resigned', 'hr/interviews', 'hr/settings', 'hr/_version', 'hr/bonus_log']);
const MODULES = Object.freeze(['hr', 'account', 'batch_accounts', 'backup', 'annual_leave', 'salary', 'schedule', 'bonus', 'set_ins_location']);
const MANAGEMENT_ROLES = ['admin', 'consultant', 'manager'];
const SECURITY = ['id', 'uid', 'idNo', 'status', 'workLocation', 'startDate', 'resignDate', 'role', 'empId', 'locations', 'msgcAllStores'];
const LEAVE_FIELDS = ['extraLeave', 'leaves', 'leaveSettled'];
const BONUS_FIELDS = ['bonuses', 'fixedBonuses'];
const SETTINGS_FIELDS = ['interviewLocations', 'workLocations', 'titleOptions', 'bankOptions', 'insuranceGrades'];
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_BYTES = 8 * 1024 * 1024;

function fail(code, message = code) { const e = new Error(message); e.code = code; throw e; }
function plain(value) { return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function stable(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (!plain(value)) fail('invalid-argument', 'JSON_SOURCE_REQUIRED');
  const keys = Object.keys(value).sort();
  if (keys.some(k => FORBIDDEN_KEYS.has(k))) fail('invalid-argument', 'UNSAFE_OBJECT_KEY');
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
}
function digest(value) { return createHash('sha256').update(stable(value ?? null)).digest('hex'); }
const same = (a, b) => stable(a ?? null) === stable(b ?? null);
const list = value => value && Array.isArray(value.list) ? value.list : [];
const id = value => value === undefined || value === null ? '' : String(value);
const idNo = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const changed = (a, b) => [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].filter(k => !same(a?.[k], b?.[k]));
const uidOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const normLoc = value => String(value ?? '').replace(/鋪/g, '舖').replace(/\s/g, '');
function actorLocations(actor, permission, permissionDoc) {
  if (actor.locations !== undefined && actor.locations !== null && !Array.isArray(actor.locations)) fail('failed-precondition', 'INVALID_ACTOR_LOCATION');
  const raw = Array.isArray(actor.locations) && actor.locations.length ? actor.locations : actor.workLocation ? [actor.workLocation] : [];
  if (raw.some(value => typeof value !== 'string' || !normLoc(value))) fail('failed-precondition', 'INVALID_ACTOR_LOCATION');
  const locationType = permission?.locationType;
  // Match auth-guard's module scope using the permissions read in this transaction.
  // null is the legacy unrestricted scope; an empty restricted scope allows no rows.
  if (!locationType || locationType === 'all') return raw.length ? raw.map(normLoc) : null;
  if (!['central', 'store'].includes(locationType)) fail('failed-precondition', 'INVALID_MODULE_LOCATION_TYPE');
  const locationTypes = permissionDoc?.locationTypes ?? {};
  if (!plain(locationTypes)) fail('failed-precondition', 'INVALID_LOCATION_TYPES');
  const matches = location => (locationTypes[location] || 'store') === locationType;
  // allOfType expands visibility only after the actor has a matching assigned shop.
  if (!raw.some(matches)) fail('permission-denied', 'MODULE_LOCATION_DENIED');
  const selected = permission.allOfType === true
    ? Object.entries(locationTypes).filter(([, type]) => type === locationType).map(([location]) => location)
    : raw.filter(matches);
  if (selected.some(location => !normLoc(location))) fail('failed-precondition', 'INVALID_MODULE_LOCATION');
  return selected.map(normLoc);
}
function allowKeys(value, allowed) { if (!plain(value) || Object.keys(value).some(k => !allowed.includes(k))) fail('invalid-argument', 'UNSUPPORTED_FIELDS'); }
function recordMap(doc) {
  if (doc === null) return new Map();
  if (!plain(doc) || !Array.isArray(doc.list)) fail('failed-precondition', 'LIST_REQUIRED');
  const result = new Map();
  for (const row of doc.list) {
    if (!plain(row) || !['number', 'string'].includes(typeof row.id) || !id(row.id) || result.has(id(row.id))) fail('failed-precondition', 'DUPLICATE_OR_INVALID_EMPLOYEE_ID');
    stable(row);
    if (row.uid !== undefined && row.uid !== '' && row.uid !== null && !uidOK(row.uid)) fail('failed-precondition', 'INVALID_EMPLOYEE_UID');
    result.set(id(row.id), row);
  }
  return result;
}
function population(current) {
  const result = new Map(), uids = new Set(), identities = new Set();
  for (const path of ['hr/employees', 'hr/resigned']) {
    for (const [key, row] of recordMap(current[path])) {
      if (result.has(key) || (row.uid && uids.has(row.uid)) || (idNo(row.idNo) && identities.has(idNo(row.idNo)))) fail('failed-precondition', 'AMBIGUOUS_LEGACY_BINDING');
      result.set(key, {path, row});
      if (row.uid) uids.add(row.uid);
      if (idNo(row.idNo)) identities.add(idNo(row.idNo));
    }
  }
  return result;
}
function identifierValues(value) {
  const values = [value];
  const str = id(value);
  if (!values.includes(str)) values.push(str);
  const numeric = Number(str);
  if (Number.isSafeInteger(numeric) && String(numeric) === str && !values.includes(numeric)) values.push(numeric);
  return values;
}
function snapshotData(snap, path) {
  if (!snap || snap.ref.path !== path || typeof snap.exists !== 'boolean') fail('internal', 'INVALID_SOURCE_SNAPSHOT');
  return snap.exists ? snap.data() : null;
}

function createWriter({db, auth, now = () => Date.now()}) {
  if (!db || !auth || typeof auth.getUser !== 'function') throw new TypeError('db and auth are required');
  return async function write(request) {
    const actorUid = request?.auth?.uid;
    if (!uidOK(actorUid)) fail('unauthenticated');
    let actorAuth;
    try { actorAuth = await auth.getUser(actorUid); } catch { fail('permission-denied', 'ACTOR_AUTH_UNAVAILABLE'); }
    if (!actorAuth || actorAuth.uid !== actorUid || actorAuth.disabled !== false) fail('permission-denied', 'ACTOR_DISABLED');
    const data = request.data;
    allowKeys(data, ['module', 'writes', 'restoreBackupId', 'deleteUserUid', 'expectedVersion']);
    if (Buffer.byteLength(stable(data)) > MAX_BYTES) fail('resource-exhausted', 'REQUEST_TOO_LARGE');
    const moduleKey = data.module;
    if (!MODULES.includes(moduleKey)) fail('invalid-argument', 'INVALID_MODULE');
    const restoring = own(data, 'restoreBackupId');
    const deletingAccount = own(data, 'deleteUserUid');
    if (restoring && (moduleKey !== 'backup' || typeof data.restoreBackupId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(data.restoreBackupId) || own(data, 'writes'))) fail('invalid-argument', 'INVALID_RESTORE');
    if (deletingAccount && (moduleKey !== 'account' || !uidOK(data.deleteUserUid) || restoring || own(data, 'writes') || data.deleteUserUid === actorUid)) fail('permission-denied', 'INVALID_ACCOUNT_DELETE');
    if (own(data, 'expectedVersion') && (moduleKey !== 'hr' || !Number.isSafeInteger(data.expectedVersion) || data.expectedVersion < 0)) fail('invalid-argument', 'INVALID_VERSION');
    const input = restoring || deletingAccount ? [] : data.writes;
    if (!restoring && !deletingAccount && (!Array.isArray(input) || !input.length || input.length > SOURCE_DOCS.length)) fail('invalid-argument', 'INVALID_WRITES');
    if (new Set(input.map(w => w?.path)).size !== input.length) fail('invalid-argument', 'DUPLICATE_PATH');
    for (const op of input) {
      allowKeys(op, ['path', 'kind', 'data', 'expectedHash', 'merge']);
      if (!SOURCE_DOCS.includes(op.path)) fail('permission-denied', 'PATH_NOT_SUPPORTED');
      if (!['set', 'update', 'delete'].includes(op.kind) || typeof op.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(op.expectedHash)) fail('invalid-argument', 'PRECONDITION_REQUIRED');
      // These documents are shared array sources. Deleting a whole document is
      // never an employee-delete operation; send an explicitly hashed new list.
      if (op.kind === 'delete') fail('permission-denied', 'SOURCE_DOCUMENT_DELETE_DENIED');
      if (!plain(op.data) || (own(op, 'merge') && typeof op.merge !== 'boolean')) fail('invalid-argument', 'INVALID_WRITE_DATA');
      allowKeys(op.data, op.path === 'hr/settings' ? SETTINGS_FIELDS : op.path === 'hr/_version' ? ['v', 'lastEditor', 'lastEditAt'] : ['list']);
      stable(op.data);
    }

    // Only identities explicitly referenced by an incoming UID are checked here.
    // Auth and Firestore cannot share a transaction; re-checks are conservative,
    // and a concurrent Auth disable is still denied by downstream qualification.
    const identities = new Map();
    const referencedUids = new Set(input.flatMap(op => ['hr/employees', 'hr/resigned'].includes(op.path) && Array.isArray(op.data.list) ? op.data.list.map(r => r?.uid).filter(Boolean) : []));
    for (const targetUid of referencedUids) {
      if (!uidOK(targetUid)) fail('invalid-argument', 'INVALID_EMPLOYEE_UID');
    }

    return db.runTransaction(async tx => {
      const basePaths = [...SOURCE_DOCS, 'settings/permissions', 'users/' + actorUid];
      const baseSnaps = await tx.getAll(...basePaths.map(path => db.doc(path)));
      const current = Object.fromEntries(basePaths.map((path, i) => [path, snapshotData(baseSnaps[i], path)]));
      const actor = current['users/' + actorUid];
      if (!actor || actor.disabled === true || !MANAGEMENT_ROLES.includes(actor.role)) fail('permission-denied', 'ACTOR_NOT_ACTIVE_MANAGER');
      const admin = actor.role === 'admin';
      const permissionKey = ['batch_accounts', 'set_ins_location'].includes(moduleKey) ? 'hr' : moduleKey;
      const permissionDoc = current['settings/permissions'];
      if (permissionDoc !== null && !plain(permissionDoc)) fail('failed-precondition', 'INVALID_PERMISSIONS');
      const permissionModules = permissionDoc?.modules;
      if (permissionModules !== undefined && !plain(permissionModules)) fail('failed-precondition', 'INVALID_PERMISSIONS');
      const permission = permissionModules?.[permissionKey];
      if (permission !== undefined && !plain(permission)) fail('failed-precondition', 'INVALID_PERMISSIONS');
      const roles = permission?.roles;
      if (roles !== undefined && (!Array.isArray(roles) || roles.some(role => typeof role !== 'string'))) fail('failed-precondition', 'INVALID_PERMISSIONS');
      // Match auth-guard's admin fallback only after the permission read succeeds.
      // A thrown SDK read is never converted into an absent permission document.
      if (roles?.length ? !roles.includes(actor.role) : !admin) fail('permission-denied', 'MODULE_DENIED');
      if (['account', 'backup', 'set_ins_location', 'batch_accounts'].includes(moduleKey) && !admin) fail('permission-denied', 'ADMIN_REQUIRED');
      if (moduleKey === 'annual_leave' && !['admin', 'consultant'].includes(actor.role)) fail('permission-denied', 'ANNUAL_LEAVE_EDITOR_REQUIRED');
      const writeLocations = admin ? null : actorLocations(actor, permission, permissionDoc);
      const oldVersion = current['hr/_version']?.v ?? 0;
      if (!Number.isSafeInteger(oldVersion) || oldVersion < 0) fail('failed-precondition', 'INVALID_SOURCE_VERSION');
      if (own(data, 'expectedVersion') && data.expectedVersion !== oldVersion) fail('aborted', 'VERSION_CONFLICT');

      let ops = input;
      let deleteUserPath = null;
      if (deletingAccount) {
        deleteUserPath = 'users/' + data.deleteUserUid;
        const target = snapshotData(await tx.get(db.doc(deleteUserPath)), deleteUserPath);
        if (!target) fail('not-found', 'ACCOUNT_NOT_FOUND');
        // Keep the old UI's UID-only deletion semantics. Missing-UID records are
        // not guessed from name/email/empId; they remain for explicit reconciliation.
        const employees = {list: list(current['hr/employees']).filter(row => row.uid !== data.deleteUserUid)};
        ops = [{path: 'hr/employees', kind: 'set', data: employees, expectedHash: digest(current['hr/employees'])}];
      }
      if (restoring) {
        const backupPath = 'hr_backups/' + data.restoreBackupId;
        const backup = snapshotData(await tx.get(db.doc(backupPath)), backupPath);
        if (!backup) fail('not-found', 'BACKUP_NOT_FOUND');
        for (const field of ['employees', 'resigned', 'interviews']) if (!Array.isArray(backup[field])) fail('failed-precondition', 'INCOMPLETE_BACKUP');
        ops = ['employees', 'resigned', 'interviews'].map(key => ({path: 'hr/' + key, kind: 'set', data: {list: backup[key]}, expectedHash: digest(current['hr/' + key])}));
      }
      const next = {...current}, touched = new Set();
      for (const op of ops) {
        if (op.expectedHash !== digest(current[op.path])) fail('aborted', 'VERSION_CONFLICT');
        if (op.kind === 'update' && current[op.path] === null) fail('not-found', 'SOURCE_NOT_FOUND');
        // Preserve any existing document metadata; clients only replace explicit
        // whitelisted data fields, never silently erase unknown legacy metadata.
        next[op.path] = {...current[op.path], ...op.data};
        stable(next[op.path]);
        touched.add(op.path);
      }
      // Inspect every row, not just incoming/chosen rows. Old malformed bindings
      // are explicit migration blockers, never silently ignored or truncated.
      const oldPopulation = population(current), newPopulation = population(next);
      const isSelf = row => !!row && (row.uid === actorUid || (id(actor.empId) && id(row.id) === id(actor.empId)) || (idNo(actor.idNo) && idNo(row.idNo) === idNo(actor.idNo)));
      const securityChanged = (b, a) => !a || !b || SECURITY.some(key => !same(b[key], a[key]));
      const affectedBindings = [], newUnbound = [];
      for (const key of new Set([...oldPopulation.keys(), ...newPopulation.keys()])) {
        const before = oldPopulation.get(key), after = newPopulation.get(key);
        const b = before?.row, a = after?.row;
        if (same(before, after)) continue;
        const authChanged = securityChanged(b, a) || before?.path !== after?.path;
        if (authChanged && (isSelf(b) || isSelf(a))) fail('permission-denied', 'SELF_HR_AUTHORIZATION_CHANGE');
        if (restoring && authChanged) fail('failed-precondition', 'BACKUP_AUTHORIZATION_CHANGE_REQUIRES_EXPLICIT_HR_ACTION');
        const fields = changed(b, a);
        if (['salary', 'schedule', 'annual_leave'].includes(moduleKey)) {
          if (!a || !b || before.path !== 'hr/employees' || after.path !== before.path || fields.some(k => !LEAVE_FIELDS.includes(k))) fail('permission-denied', 'LEAVE_FIELDS_ONLY');
        } else if (moduleKey === 'bonus') {
          if (!a || !b || before.path !== 'hr/employees' || after.path !== before.path || fields.some(k => !BONUS_FIELDS.includes(k))) fail('permission-denied', 'BONUS_FIELDS_ONLY');
        } else if (moduleKey === 'set_ins_location') {
          if (!a || !b || before.path !== 'hr/employees' || after.path !== before.path || fields.some(k => k !== 'insurance')) fail('permission-denied', 'INSURANCE_FIELDS_ONLY');
        } else if (moduleKey === 'account') {
          if (a || !b || before.path !== 'hr/employees') fail('permission-denied', 'ACCOUNT_DELETE_ONLY');
        } else if (moduleKey === 'batch_accounts') {
          if (!a || !b || after.path !== before.path || before.path !== 'hr/employees' || fields.some(k => k !== 'uid') || b.uid || !a.uid) fail('permission-denied', 'INITIAL_UID_BIND_ONLY');
        } else if (!['hr', 'backup'].includes(moduleKey)) fail('permission-denied', 'MODULE_SOURCE_MISMATCH');
        if (!admin) {
          if (!a || after.path !== 'hr/employees' || (b && before.path !== after.path)) fail('permission-denied', 'ADMIN_REQUIRED');
          // HR first fills the previously blank draft identity and creates an
          // employee-only account shell before its first UID binding. Permit
          // exactly that transition; account/Auth/uniqueness checks below remain
          // mandatory. Existing nonblank identities are never editable this way.
          const firstDraftIdentity = !!b && !b.uid && !idNo(b.idNo) && !!a.uid && !!idNo(a.idNo);
          if (b && SECURITY.some(k => k !== 'uid' && !(k === 'idNo' && firstDraftIdentity) && !same(b[k], a[k]))) fail('permission-denied', 'ADMIN_AUTHORIZATION_REQUIRED');
          if (b?.uid && b.uid !== a.uid) fail('permission-denied', 'REBIND_DENIED');
          if (!b && (a.status !== '在職' || (a.role && a.role !== 'employee'))) fail('permission-denied', 'NEW_EMPLOYEE_STATUS_INVALID');
          if (writeLocations && [b, a].filter(Boolean).some(row => !writeLocations.includes(normLoc(row.workLocation)))) fail('permission-denied', 'CROSS_STORE_WRITE');
        }
        if (b?.uid && a && b.uid !== a.uid) fail('failed-precondition', 'REBIND_REQUIRES_SEPARATE_REVIEW');
        if (a?.uid && (!b || b.uid !== a.uid || !same(b.idNo, a.idNo) || !same(b.id, a.id))) affectedBindings.push({row: a, initial: !b?.uid});
        // Existing interview-transfer flow creates an unbound HR draft with no
        // idNo/UID. Retain that workflow; an empId match still cannot recreate an
        // existing account's missing HR binding. Drafts confer no MSGC eligibility.
        if (a && !a.uid && (!b || !same(b.idNo, a.idNo))) newUnbound.push(a);
      }
      for (const path of touched) {
        const value = next[path];
        if (path === 'hr/employees' || path === 'hr/resigned') {
          if (path === 'hr/resigned' && !['hr', 'backup'].includes(moduleKey)) fail('permission-denied', 'RESIGNED_MODULE_DENIED');
        } else if (path === 'hr/_version') {
          allowKeys(value, ['v', 'lastEditor', 'lastEditAt']);
          // Values are ignored: server owns monotonic version and actor metadata.
        } else if (path === 'hr/interviews') {
          if (!['hr', 'backup'].includes(moduleKey)) fail('permission-denied', 'INTERVIEWS_MODULE_DENIED');
          if (!Array.isArray(value.list)) fail('invalid-argument', 'LIST_REQUIRED');
        } else if (path === 'hr/settings') {
          if (moduleKey !== 'hr') fail('permission-denied', 'SETTINGS_MODULE_DENIED');
          for (const field of SETTINGS_FIELDS) if (own(value, field) && !Array.isArray(value[field])) fail('invalid-argument', 'SETTINGS_ARRAY_REQUIRED');
        } else if (path === 'hr/bonus_log') {
          if (moduleKey !== 'bonus') fail('permission-denied', 'BONUS_LOG_MODULE_DENIED');
          if (!Array.isArray(value.list)) fail('invalid-argument', 'LIST_REQUIRED');
          const previous = new Map(list(current[path]).map(row => [row.id, row]));
          const after = new Map();
          const legacyEditable = row => {
            const employee = newPopulation.get(id(row.empId));
            if (!employee || employee.path !== 'hr/employees') return false;
            return writeLocations === null || writeLocations.includes(normLoc(employee.row.workLocation));
          };
          const allowedLegacyLabel = (before, row) => {
            if (before.cat !== 'fixed' || typeof before.key !== 'string' || !before.key.startsWith('health_') || !legacyEditable(before)) return false;
            const want = '🏥 ' + before.key.replace('health_', '') + '健康檢查補助';
            // Match the existing migration exactly. A correct prefix (including
            // a $0 reason suffix) must never be shortened or otherwise edited.
            return (!before.label || (typeof before.label === 'string' && !before.label.startsWith(want))) && row.label === want && changed(before, row).every(key => key === 'label');
          };
          for (const row of value.list) {
            if (!plain(row) || typeof row.id !== 'string' || !row.id || after.has(row.id)) fail('invalid-argument', 'BONUS_LOG_ID_INVALID');
            if (previous.has(row.id) && !same(previous.get(row.id), row) && !allowedLegacyLabel(previous.get(row.id), row)) fail('permission-denied', 'BONUS_LOG_IMMUTABLE');
            if (!previous.has(row.id)) {
              const emp = newPopulation.get(id(row.empId))?.row;
              if (!emp) fail('invalid-argument', 'BONUS_EMPLOYEE_NOT_FOUND');
              if (writeLocations && !writeLocations.includes(normLoc(emp.workLocation))) fail('permission-denied', 'CROSS_STORE_WRITE');
              if (typeof row.amount !== 'number' || !Number.isFinite(row.amount) || row.amount < 0) fail('invalid-argument', 'BONUS_AMOUNT_INVALID');
              // Do not trust caller-supplied display name, scope or operator.
              row.operator = actor.name || actorUid;
              row.empName = emp.name || '';
              row.workLocation = emp.workLocation || '';
              row.createdAt = new Date(now()).toISOString();
            }
            after.set(row.id, row);
          }
          if (!admin) for (const [key, row] of previous) if (!after.has(key)) {
            const legacy = row.operator === '（資料遷移）' && row.cat === 'fixed' && typeof row.key === 'string' && (row.key === 'shoe' || row.key.startsWith('health_'));
            const employee = newPopulation.get(id(row.empId))?.row;
            if (!legacy || !legacyEditable(row) || employee.fixedBonuses?.[row.key] !== false) fail('permission-denied', 'BONUS_REVERT_ADMIN_REQUIRED');
          }
        }
      }

      for (const row of newUnbound) {
        const queries = [db.collection('users').where('empId', 'in', identifierValues(row.id)).limit(1)];
        if (idNo(row.idNo)) queries.push(db.collection('users').where('idNo', 'in', [...new Set([idNo(row.idNo), idNo(row.idNo).toLowerCase()])]).limit(1));
        for (const query of queries) if ((await tx.get(query)).docs.length) fail('failed-precondition', 'UNBOUND_EXISTING_ACCOUNT_REQUIRES_RECONCILIATION');
      }
      for (const {row, initial} of affectedBindings) {
        const targetUid = row.uid;
        const userPath = 'users/' + targetUid;
        const account = snapshotData(await tx.get(db.doc(userPath)), userPath);
        if (!account || id(account.empId) !== id(row.id) || !idNo(row.idNo) || idNo(account.idNo) !== idNo(row.idNo)) fail('failed-precondition', 'BINDING_MISMATCH');
        if (initial && (account.role !== 'employee' || account.disabled === true)) fail('permission-denied', 'INITIAL_BIND_REQUIRES_EMPLOYEE_SHELL');
        const matchingQueries = [
          db.collection('users').where('empId', 'in', identifierValues(row.id)).limit(2),
          db.collection('users').where('idNo', 'in', [...new Set([idNo(row.idNo), idNo(row.idNo).toLowerCase()])]).limit(2)
        ];
        for (const query of matchingQueries) {
          const found = await tx.get(query);
          if (found.docs.length !== 1 || found.docs[0].id !== targetUid) fail('failed-precondition', 'DUPLICATE_OR_AMBIGUOUS_ACCOUNT_BINDING');
        }
        if (!identities.has(targetUid)) {
          try { identities.set(targetUid, await auth.getUser(targetUid)); } catch { fail('failed-precondition', 'TARGET_AUTH_UNAVAILABLE'); }
        }
        const au = identities.get(targetUid);
        if (!au || au.uid !== targetUid || (initial && au.disabled !== false) || typeof au.email !== 'string' || au.email.toLowerCase() !== idNo(row.idNo).toLowerCase() + '@liangpinghri.com') fail('failed-precondition', 'TARGET_AUTH_IDENTITY_MISMATCH');
      }
      if (moduleKey === 'account' && !deletingAccount) {
        for (const [key, before] of oldPopulation) if (!newPopulation.has(key) && before.row.uid) {
          const path = 'users/' + before.row.uid;
          if (snapshotData(await tx.get(db.doc(path)), path) !== null) fail('failed-precondition', 'DELETE_ACCOUNT_FIRST');
        }
      }
      // All Firestore reads are complete before the first transaction write.
      const at = new Date(now()).toISOString();
      if (deleteUserPath) tx.delete(db.doc(deleteUserPath));
      if (restoring) tx.create(db.collection('hr_backups').doc(), {preRestore: true, createdAt: at, restoreTarget: data.restoreBackupId, createdBy: actorUid, employees: list(current['hr/employees']), resigned: list(current['hr/resigned']), interviews: list(current['hr/interviews'])});
      for (const path of touched) if (path !== 'hr/_version') tx.set(db.doc(path), next[path]);
      const version = oldVersion + 1;
      if (!Number.isSafeInteger(version)) fail('resource-exhausted', 'SOURCE_VERSION_OVERFLOW');
      tx.set(db.doc('hr/_version'), {v: version, lastEditor: actor.name || actorUid, lastEditAt: at});
      tx.create(db.collection('hr_source_audit').doc(), {actor: actorUid, module: moduleKey, paths: [...touched].filter(path => path !== 'hr/_version').concat(deleteUserPath || []), at, restore: restoring, accountDelete: deletingAccount, version});
      const hashes = Object.fromEntries([...touched].filter(path => path !== 'hr/_version').map(path => [path, digest(next[path])]));
      // Only the touched bonus document is returned, not general HR personnel.
      // This lets clients retain authoritative metadata for their next hashed save.
      const documents = touched.has('hr/bonus_log') ? {'hr/bonus_log': next['hr/bonus_log']} : {};
      return {ok: true, version, hashes, documents};
    });
  };
}

module.exports = {createWriter, stable, digest, SOURCE_DOCS};
