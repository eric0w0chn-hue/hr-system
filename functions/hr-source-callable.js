'use strict';
// Firebase verifies callable tokens; additionally enforce revocation and a fixed project here.
function createHrSourceCallable({writer,auth,projectId,HttpsError}) {
  if (typeof writer !== 'function' || typeof auth?.verifyIdToken !== 'function' || !projectId || typeof HttpsError !== 'function') throw Error('CALLABLE_DEPENDENCIES_REQUIRED');
  const exposed = new Set(['invalid-argument','unauthenticated','permission-denied','not-found','already-exists','resource-exhausted','failed-precondition','aborted','unavailable']);
  return async request => {
    if (!request.auth?.uid) throw new HttpsError('unauthenticated','LOGIN_REQUIRED');
    const header = request.rawRequest?.headers?.authorization;
    if (typeof header !== 'string' || !/^Bearer \S+$/.test(header)) throw new HttpsError('unauthenticated','TOKEN_REQUIRED');
    let decoded;
    try { decoded = await auth.verifyIdToken(header.slice(7), true); }
    catch (_) { throw new HttpsError('unauthenticated','TOKEN_REJECTED'); }
    if (decoded.uid !== request.auth.uid || decoded.aud !== projectId || decoded.iss !== 'https://securetoken.google.com/' + projectId) throw new HttpsError('unauthenticated','TOKEN_CONTEXT_MISMATCH');
    try { return await writer(request); }
    catch (error) {
      // Do not return SDK exceptions, request data or personal records to a client/log.
      if (exposed.has(error?.code)) throw new HttpsError(error.code, /^[A-Z0-9_]{1,100}$/.test(error.message || '') ? error.message : 'SOURCE_WRITE_REJECTED');
      throw new HttpsError('internal','SOURCE_WRITE_FAILED');
    }
  };
}
module.exports = {createHrSourceCallable};
