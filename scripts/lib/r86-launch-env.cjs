/* global module */
/** Match an independent desktop launch instead of inheriting the coding host's
 * conversation handles. Keep all native channel, home, credentials and proxies.
 * Does not change the product's identity algorithm or an existing task scope. */
function engineeringLaunchEnvironment(source,port){
 const env={...source};
 for(const key of Object.keys(env))if(key.startsWith('ZS_')||key==='ELECTRON_RUN_AS_NODE')delete env[key];
 for(const key of ['CODEX_SESSION_ID','CODEX_THREAD_ID','CODEX_APP_TOOLS_PIPE_PATH','CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY'])delete env[key];
 env.ZS_DEV25_DEBUG_PORT=String(port);return env;
}
module.exports={engineeringLaunchEnvironment};
