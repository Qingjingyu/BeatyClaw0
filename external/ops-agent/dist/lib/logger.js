const PREFIX = '[ops-agent]';
function ts() {
    return new Date().toISOString();
}
export function info(msg, meta) {
    const line = meta ? `${PREFIX} ${ts()} INFO  ${msg} ${JSON.stringify(meta)}` : `${PREFIX} ${ts()} INFO  ${msg}`;
    process.stdout.write(line + '\n');
}
export function warn(msg, meta) {
    const line = meta ? `${PREFIX} ${ts()} WARN  ${msg} ${JSON.stringify(meta)}` : `${PREFIX} ${ts()} WARN  ${msg}`;
    process.stderr.write(line + '\n');
}
export function error(msg, meta) {
    const line = meta ? `${PREFIX} ${ts()} ERROR ${msg} ${JSON.stringify(meta)}` : `${PREFIX} ${ts()} ERROR ${msg}`;
    process.stderr.write(line + '\n');
}
//# sourceMappingURL=logger.js.map