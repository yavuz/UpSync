import * as fs from 'fs';
import * as path from 'path';
import * as Joi from 'joi';
import { parse as parseJsonc, ParseError, printParseErrorCode } from 'jsonc-parser';

// vscode-sftp'nin config şeması birebir korunuyor: mevcut sftp.json dosyaları
// hiçbir değişiklik olmadan çalışsın diye.
const nullable = schema => schema.optional().allow(null);

const configScheme = {
  name: Joi.string(),

  context: Joi.string(),
  protocol: Joi.any().valid('sftp', 'ftp', 'local'),

  host: Joi.string().required(),
  port: Joi.number().integer(),
  connectTimeout: Joi.number().integer(),
  username: Joi.string().required(),
  password: nullable(Joi.string().allow(true)),

  agent: nullable(Joi.string()),
  privateKeyPath: nullable(Joi.string()),
  passphrase: nullable(Joi.string().allow(true)),
  interactiveAuth: Joi.alternatives([Joi.boolean(), Joi.array().items(Joi.string())]).optional(),
  algorithms: Joi.any(),
  sshConfigPath: Joi.string(),
  sshCustomParams: Joi.string(),

  secure: Joi.any().valid(true, false, 'control', 'implicit'),
  secureOptions: nullable(Joi.object()),
  passive: Joi.boolean(),

  remotePath: Joi.string().required(),
  uploadOnSave: Joi.boolean(),
  useTempFile: Joi.boolean(),
  openSsh: Joi.boolean(),
  downloadOnOpen: Joi.boolean().allow('confirm'),

  filePerm: Joi.number(),
  dirPerm: Joi.number(),

  ignore: Joi.array().min(0).items(Joi.string()),
  ignoreFile: Joi.string(),
  watcher: {
    files: Joi.string().allow(false, null),
    autoUpload: Joi.boolean(),
    autoDelete: Joi.boolean(),
  },
  concurrency: Joi.number().integer(),

  syncOption: {
    delete: Joi.boolean(),
    skipCreate: Joi.boolean(),
    ignoreExisting: Joi.boolean(),
    update: Joi.boolean(),
  },
  remoteTimeOffsetInHours: Joi.number(),

  remoteExplorer: {
    filesExclude: Joi.array().min(0).items(Joi.string()),
    order: Joi.number(),
  },

  profiles: Joi.object(),
  defaultProfile: Joi.string(),
};

const defaultConfig = {
  remotePath: './',
  uploadOnSave: false,
  useTempFile: false,
  openSsh: false,
  downloadOnOpen: false,
  ignore: [],
  concurrency: 4,
  protocol: 'sftp',
  connectTimeout: 10 * 1000,
  interactiveAuth: false,
  secure: false,
  remoteTimeOffsetInHours: 0,
  remoteExplorer: {
    order: 0,
  },
};

// Arama sırası: .zed → .vscode → kök. Zed eklentisiyle ve vscode-sftp ile uyumlu.
export const CONFIG_CANDIDATES = [
  path.join('.zed', 'sftp.json'),
  path.join('.vscode', 'sftp.json'),
  'sftp.json',
];

export function findConfigPath(folder: string): string | null {
  for (const candidate of CONFIG_CANDIDATES) {
    const p = path.join(folder, candidate);
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

export class ConfigError extends Error {
  constructor(message: string, readonly configPath: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function validateConfig(config): { message: string } | null {
  const { error } = Joi.validate(config, configScheme, {
    allowUnknown: true,
    convert: false,
    language: {
      object: {
        child: '!!prop "{{!child}}" fails because {{reason}}',
      },
    },
  });
  return error || null;
}

export function readConfigs(configPath: string): any[] {
  const raw = fs.readFileSync(configPath, 'utf8');

  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length) {
    const first = errors[0];
    const line = raw.slice(0, first.offset).split('\n').length;
    throw new ConfigError(
      `JSON error on line ${line}: ${printParseErrorCode(first.error)}`,
      configPath
    );
  }

  if (parsed === undefined) {
    throw new ConfigError('The config file is empty.', configPath);
  }

  const configs = Array.isArray(parsed) ? parsed : [parsed];
  return configs.map(c => ({ ...defaultConfig, ...c }));
}
