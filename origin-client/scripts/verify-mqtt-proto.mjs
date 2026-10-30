// Verify all MQTT topics/messageTypes used in the codebase resolve against the generated proto JSON.
import fs from 'node:fs';
import path from 'node:path';
import protobuf from 'protobufjs';

const repoRoot = process.cwd();
const jsonPath = path.join(repoRoot, 'src', 'generated', 'mqtt-proto.json');
const protoJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const root = protobuf.Root.fromJSON(protoJson);

const allMessages = Object.keys(protoJson.nested);
console.log(`[proto] ${allMessages.length} messages available in flat namespace:`);
console.log('   ' + allMessages.join(', '));

function getMessageFields(messageName) {
  const message = protoJson.nested[messageName];
  if (!message?.fields) {
    throw new Error(`Missing proto message: ${messageName}`);
  }
  return message.fields;
}

function assertField(messageName, fieldNames, id, type) {
  const fields = getMessageFields(messageName);
  const names = Array.isArray(fieldNames) ? fieldNames : [fieldNames];
  const fieldName = names.find((name) => fields[name]);
  const field = fieldName ? fields[fieldName] : null;
  if (!field) {
    throw new Error(`${messageName} is missing field ${names.join(' / ')}`);
  }
  if (field.id !== id) {
    throw new Error(`${messageName}.${fieldName} expected id ${id}, got ${field.id}`);
  }
  if (type && field.type !== type) {
    throw new Error(`${messageName}.${fieldName} expected type ${type}, got ${field.type}`);
  }
}

function assertOptionalField(messageName, fieldNames, id, type) {
  assertField(messageName, fieldNames, id, type);
  const fields = getMessageFields(messageName);
  const names = Array.isArray(fieldNames) ? fieldNames : [fieldNames];
  const fieldName = names.find((name) => fields[name]);
  const oneofName = `_${fieldName}`;
  const oneof = protoJson.nested[messageName]?.oneofs?.[oneofName]?.oneof;
  if (!Array.isArray(oneof) || !oneof.includes(fieldName)) {
    throw new Error(`${messageName}.${fieldName} must preserve proto3 optional presence`);
  }
}

function assertNoMessage(messageName) {
  if (protoJson.nested[messageName]) {
    throw new Error(`${messageName} should not be present in the RM2026 V2 custom-client proto`);
  }
}

function assertRm2026V2ProtocolShape() {
  assertOptionalField('GameStatus', ['game_result', 'gameResult'], 9, 'uint32');
  assertOptionalField('GameStatus', ['end_reason', 'endReason'], 10, 'uint32');

  assertField('MapClickInfo', ['is_send_all', 'isSendAll'], 1, 'uint32');
  assertField('MapClickInfo', ['robot_id', 'robotId'], 2, 'bytes');
  assertField('MapClickInfo', 'type', 6, 'uint32');
  assertField('MapClickCmd', ['is_send_all', 'isSendAll'], 1, 'uint32');
  assertNoMessage('MapClickInfoNotify');

  assertField('SentryStatusSync', ['is_powered', 'isPowered'], 3, 'bool');
  assertField('DartCommand', ['launch_confirm', 'launchConfirm'], 3, 'bool');
  assertField('AirSupportStatusSync', ['is_being_targeted', 'isBeingTargeted'], 4, 'uint32');
  assertField('AirSupportStatusSync', ['shooter_status', 'shooterStatus'], 5, 'uint32');

  assertField('RadarInfoToClient', 'RadarSingleRobotInfo', 1, 'RadarSingleRobotInfo');
  assertOptionalField('RadarSingleRobotInfo', ['target_pos_x', 'targetPosX'], 1, 'uint32');
  assertOptionalField('RadarSingleRobotInfo', ['target_pos_y', 'targetPosY'], 2, 'uint32');
  assertOptionalField('RadarSingleRobotInfo', ['is_high_light', 'isHighLight'], 3, 'uint32');

  // Every non-repeated field in the official V2.0.0 schema is proto3 optional.
  for (const [messageName, message] of Object.entries(protoJson.nested)) {
    for (const [fieldName, field] of Object.entries(message.fields ?? {})) {
      if (field.rule === 'repeated') continue;
      const oneof = message.oneofs?.[`_${fieldName}`]?.oneof;
      if (!Array.isArray(oneof) || !oneof.includes(fieldName)) {
        throw new Error(`${messageName}.${fieldName} must preserve proto3 optional presence`);
      }
    }
  }
}

try {
  assertRm2026V2ProtocolShape();
  console.log('\n[rm2026-v2] Required V2.0.0 custom-client fields are present ✅');
} catch (error) {
  console.error(`\n[rm2026-v2] ${error.message}`);
  process.exitCode = 1;
}

// Scan source files for topic/messageType usages
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'target') continue;
      out.push(...walk(p));
    } else if (/\.(ts|vue)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

const srcFiles = walk(path.join(repoRoot, 'src'));
// Matches:
//   topic: 'X'
//   messageType: 'X'
//   sendMqttCommand('X', 'X', ...)
//   lookupType('X'), lookupType("X")
const patterns = [
  /(?:topic|messageType)\s*:\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /sendMqttCommand\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*,\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /lookupType\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g,
];
const used = new Map(); // name -> Set<file>

for (const f of srcFiles) {
  const text = fs.readFileSync(f, 'utf8');
  for (const regex of patterns) {
    let m;
    while ((m = regex.exec(text)) !== null) {
      for (let i = 1; i < m.length; i++) {
        if (!m[i]) continue;
        const name = m[i];
        if (!used.has(name)) used.set(name, new Set());
        used.get(name).add(path.relative(repoRoot, f));
      }
    }
  }
}

console.log(`\n[scan] Found ${used.size} unique topic/messageType literals:\n`);

const missing = [];
const ok = [];
for (const [name, files] of used) {
  try {
    root.lookupType(name);
    ok.push(name);
  } catch {
    // It may not be an actual proto type (e.g., a generic topic path). Only flag if
    // it looks like a proto type name (PascalCase without separators).
    if (/^[A-Z][A-Za-z0-9]+$/.test(name)) {
      missing.push({ name, files: [...files] });
    }
  }
}

console.log(`  OK (${ok.length}): ${ok.sort().join(', ')}`);
if (missing.length) {
  console.log(`\n  MISSING (${missing.length}):`);
  for (const { name, files } of missing) {
    console.log(`   - ${name}  (in ${files.join(', ')})`);
  }
  process.exitCode = 1;
} else {
  console.log('\nAll proto-like topic/messageType literals are resolvable ✅');
}

// Also check: are there any proto messages NOT referenced from the frontend?
const unused = allMessages.filter((m) => !used.has(m));
if (unused.length) {
  console.log(`\n[info] Proto messages with no frontend topic literal (may be subscribed via dynamic path):`);
  console.log('   ' + unused.join(', '));
}

// Verify DEFAULT_MQTT_CONFIG.topics (subscriptions) all resolve to proto types.
const constantsPath = path.join(repoRoot, 'src', 'components', 'Dashboard', 'constants.ts');
if (fs.existsSync(constantsPath)) {
  const text = fs.readFileSync(constantsPath, 'utf8');
  const defaultConfigMatch = text.match(/DEFAULT_MQTT_CONFIG[\s\S]*?topics:\s*\[([\s\S]*?)\]/);
  if (defaultConfigMatch) {
    const topicList = [...defaultConfigMatch[1].matchAll(/['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)].map((m) => m[1]);
    const upstreamTopics = new Set([
      'KeyboardMouseControl', 'CustomControl', 'MapClickCmd', 'AssemblyCommand',
      'RobotPerformanceSelectionCommand', 'CommonCommand', 'HeroDeployModeEventCommand',
      'RuneActivateCommand', 'DartCommand', 'SentryCtrlCommand', 'AirSupportCommand'
    ]);
    const downstreamTopics = allMessages.filter(
      (name) => name !== 'RadarSingleRobotInfo' && !upstreamTopics.has(name)
    );
    const missingSubs = downstreamTopics.filter((t) => !topicList.includes(t));
    const invalidSubs = topicList.filter((t) => !downstreamTopics.includes(t));
    console.log(`\n[subscriptions] DEFAULT_MQTT_CONFIG.topics: ${topicList.length} entries`);
    if (missingSubs.length || invalidSubs.length) {
      if (missingSubs.length) console.log(`   MISSING downstream topics: ${missingSubs.join(', ')}`);
      if (invalidSubs.length) console.log(`   INVALID/non-downstream topics: ${invalidSubs.join(', ')}`);
      process.exitCode = 1;
    } else {
      console.log('   Exactly matches all server-to-client topics ✅');
    }
  }
}
