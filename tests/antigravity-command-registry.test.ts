import { describe, expect, it } from 'vitest';
import {
  AntigravityCommandRegistry,
  parseAgyHelp,
  validateCliInvocation
} from '../src/services/antigravity-command-registry.js';
import { loadConfig } from '../src/config.js';

const sampleAgyHelp = `
Usage of agy.exe:
  --add-dir                       Add a directory to the workspace (repeatable) (default [])
  --agent                         Agent for the current CLI session
  -c                              Short alias for --continue

Available subcommands:
  agent           List available agents
  agents          List available agents
  changelog       Show changelog and release notes
  help            Show help for subcommands
  install         Configure environment paths and shell settings
  mcp             Manage MCP servers (add, remove, list, enable, disable)
  mic-serve       Serve this machine's microphone to a CLI on another host
  models          List available models
  plugin          Manage plugins (install, uninstall, list, enable, disable)
  plugins         Alias for plugin
  update          Update CLI
`;

const samplePluginHelp = `
Usage: agy.exe plugin <command> [arguments]

Commands:
  list                   List imported plugins
  import [source]        Import plugins from gemini or claude
  install <target>       Install a plugin (supports plugin@marketplace)
  uninstall <name>       Uninstall a plugin
  enable <name>          Enable a plugin
  disable <name>         Disable a plugin
`;

describe('AntigravityCommandRegistry - Help Parsing', () => {
  it('parses Available subcommands from agy --help', () => {
    const commands = parseAgyHelp(sampleAgyHelp);
    expect(commands.map((c) => c.name)).toEqual([
      'agent', 'agents', 'changelog', 'help', 'install',
      'mcp', 'mic-serve', 'models', 'plugin', 'plugins', 'update'
    ]);
    expect(commands.find((c) => c.name === 'models')?.description).toBe('List available models');
    expect(commands.find((c) => c.name === 'changelog')?.description).toBe('Show changelog and release notes');
  });

  it('parses Commands from subcommand help', () => {
    const subcommands = parseAgyHelp(samplePluginHelp);
    expect(subcommands.map((c) => c.name)).toEqual([
      'list', 'import', 'install', 'uninstall', 'enable', 'disable'
    ]);
  });
});

describe('AntigravityCommandRegistry - Validation', () => {
  it('allows safe command and arguments', () => {
    expect(() => validateCliInvocation('models', [])).not.toThrow();
    expect(() => validateCliInvocation('models', ['--help'])).not.toThrow();
    expect(() => validateCliInvocation('changelog', [])).not.toThrow();
    expect(() => validateCliInvocation('plugin', ['list'])).not.toThrow();
    expect(() => validateCliInvocation('mcp', ['list'])).not.toThrow();
  });

  it('rejects path traversal and absolute paths', () => {
    expect(() => validateCliInvocation('models', ['../secret'])).toThrow(/segurança/);
    expect(() => validateCliInvocation('models', ['/etc/passwd'])).toThrow(/segurança/);
    expect(() => validateCliInvocation('models', ['C:\\Windows\\System32'])).toThrow(/segurança/);
    expect(() => validateCliInvocation('models', ['~/.gemini'])).toThrow(/segurança/);
  });

  it('rejects shell metacharacters and command injection', () => {
    expect(() => validateCliInvocation('models', ['foo; rm -rf /'])).toThrow(/segurança/);
    expect(() => validateCliInvocation('models', ['foo | cat'])).toThrow(/segurança/);
    expect(() => validateCliInvocation('models', ['foo && ls'])).toThrow(/segurança/);
    expect(() => validateCliInvocation('models', ['$(whoami)'])).toThrow(/segurança/);
    expect(() => validateCliInvocation('models', ['`id`'])).toThrow(/segurança/);
    expect(() => validateCliInvocation('models', ['%PATH%'])).toThrow(/segurança/);
    expect(() => validateCliInvocation('models', ['foo\0bar'])).toThrow(/segurança/);
  });

  it('rejects environment and internal flag overrides', () => {
    expect(() => validateCliInvocation('models', ['--env=SECRET=123'])).toThrow(/segurança/);
    expect(() => validateCliInvocation('models', ['--header=Authorization: Bearer x'])).toThrow(/segurança/);
    expect(() => validateCliInvocation('models', ['--prompt=malicious'])).toThrow(/segurança/);
  });
});

describe('AntigravityCommandRegistry - Execution & Policy', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    NUMIA_SERVER_TOKEN: 'a'.repeat(64),
    DATA_DIR: 'test-data'
  });

  it('discovers commands, classifies executable vs restricted and caches results', async () => {
    let callCount = 0;
    const mockRunner = async (args: string[]) => {
      callCount += 1;
      if (args[0] === '--help') {
        return {
          args,
          stdout: sampleAgyHelp,
          stderr: '',
          exitCode: 0,
          timedOut: false,
          durationMs: 15,
          truncated: false
        };
      }
      return {
        args,
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 10,
        truncated: false
      };
    };

    const registry = new AntigravityCommandRegistry(config, mockRunner);
    const commands1 = await registry.discoverCommands();
    expect(commands1.length).toBe(11);
    expect(callCount).toBe(1);

    const modelsCmd = commands1.find((c) => c.name === 'models');
    expect(modelsCmd?.executable).toBe(true);

    const installCmd = commands1.find((c) => c.name === 'install');
    expect(installCmd?.executable).toBe(false);
    expect(installCmd?.restriction).toContain('sessão interativa');

    const updateCmd = commands1.find((c) => c.name === 'update');
    expect(updateCmd?.executable).toBe(false);
    expect(updateCmd?.restriction).toContain('cli_update');

    // Cached call
    const commands2 = await registry.discoverCommands();
    expect(callCount).toBe(1);
    expect(commands2.length).toBe(11);

    // Invalidation
    registry.invalidate();
    await registry.discoverCommands();
    expect(callCount).toBe(2);
  });

  it('executes allowed command and redacts sensitive data from output', async () => {
    const mockRunner = async (args: string[]) => {
      if (args[0] === '--help') {
        return { args, stdout: sampleAgyHelp, stderr: '', exitCode: 0, timedOut: false, durationMs: 10, truncated: false };
      }
      return {
        args,
        stdout: `User token is Bearer super-secret-token-12345678 and path is C:\\Users\\joaoe\\.gemini\\auth.json`,
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 25,
        truncated: false
      };
    };

    const registry = new AntigravityCommandRegistry(config, mockRunner);
    const result = await registry.executeCommand('models', []);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('super-secret-token-12345678');
    expect(result.stdout).toContain('Bearer [REDACTED]');
    expect(result.stdout).toContain('[REDACTED_AUTH_PATH]');
  });

  it('rejects interactive commands when execution is attempted', async () => {
    const mockRunner = async (args: string[]) => ({
      args,
      stdout: sampleAgyHelp,
      stderr: '',
      exitCode: 0,
      timedOut: false,
      durationMs: 10,
      truncated: false
    });

    const registry = new AntigravityCommandRegistry(config, mockRunner);
    await expect(registry.executeCommand('install', [])).rejects.toThrow(/sessão interativa/);
    await expect(registry.executeCommand('update', [])).rejects.toThrow(/cli_update/);
    await expect(registry.executeCommand('mic-serve', [])).rejects.toThrow(/sessão interativa/);
  });

  it('provides general and command-specific help', async () => {
    const mockRunner = async (args: string[]) => {
      if (args[0] === '--help') {
        return { args, stdout: sampleAgyHelp, stderr: '', exitCode: 0, timedOut: false, durationMs: 10, truncated: false };
      }
      if (args[0] === 'models' && args[1] === '--help') {
        return { args, stdout: 'Usage: agy models [options]\n  -v, --verbose  Verbose model info', stderr: '', exitCode: 0, timedOut: false, durationMs: 10, truncated: false };
      }
      return { args, stdout: '', stderr: '', exitCode: 0, timedOut: false, durationMs: 10, truncated: false };
    };

    const registry = new AntigravityCommandRegistry(config, mockRunner);
    const generalHelp = await registry.getCommandHelp();
    expect(generalHelp.title).toBe('Antigravity CLI');
    expect(Array.isArray(generalHelp.commands)).toBe(true);

    const specificHelp = await registry.getCommandHelp('models');
    expect(specificHelp.command).toBe('models');
    expect(String(specificHelp.documentation)).toContain('Usage: agy models');
  });
});
