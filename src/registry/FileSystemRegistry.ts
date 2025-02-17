import fs from 'fs';
import path from 'path';
import type { Logger } from 'pino';
import { parse as yamlParse } from 'yaml';

import type { ChainMap, ChainMetadata, ChainName, WarpCoreConfig } from '@hyperlane-xyz/sdk';

import { SCHEMA_REF } from '../consts.js';
import { ChainAddresses, ChainAddressesSchema } from '../types.js';
import { toYamlString } from '../utils.js';
import { CHAIN_FILE_REGEX } from './BaseRegistry.js';
import {
  RegistryType,
  type ChainFiles,
  type IRegistry,
  type RegistryContent,
} from './IRegistry.js';
import { SynchronousRegistry } from './SynchronousRegistry.js';
import { warpConfigToWarpAddresses } from './warp-utils.js';

export interface FileSystemRegistryOptions {
  uri: string;
  logger?: Logger;
}

/**
 * A registry that uses a local file system path as its data source.
 * Requires file system access so it cannot be used in the browser.
 */
export class FileSystemRegistry extends SynchronousRegistry implements IRegistry {
  public readonly type = RegistryType.FileSystem;

  constructor(options: FileSystemRegistryOptions) {
    super(options);
  }

  listRegistryContent(): RegistryContent {
    if (this.listContentCache) return this.listContentCache;

    const chainFileList = this.listFiles(path.join(this.uri, this.getChainsPath()));
    const chains: ChainMap<ChainFiles> = {};
    for (const chainFilePath of chainFileList) {
      const matches = chainFilePath.match(CHAIN_FILE_REGEX);
      if (!matches) continue;
      const [_, chainName, fileName] = matches;
      chains[chainName] ??= {};
      // @ts-ignore allow dynamic key assignment
      chains[chainName][fileName] = chainFilePath;
    }

    // TODO add handling for deployment artifact files here too

    return (this.listContentCache = { chains, deployments: {} });
  }

  getMetadata(): ChainMap<ChainMetadata> {
    if (this.metadataCache) return this.metadataCache;
    const chainMetadata: ChainMap<ChainMetadata> = {};
    const repoContents = this.listRegistryContent();
    for (const [chainName, chainFiles] of Object.entries(repoContents.chains)) {
      if (!chainFiles.metadata) continue;
      const data = fs.readFileSync(chainFiles.metadata, 'utf8');
      chainMetadata[chainName] = yamlParse(data);
    }
    return (this.metadataCache = chainMetadata);
  }

  getAddresses(): ChainMap<ChainAddresses> {
    if (this.addressCache) return this.addressCache;
    const chainAddresses: ChainMap<ChainAddresses> = {};
    const repoContents = this.listRegistryContent();
    for (const [chainName, chainFiles] of Object.entries(repoContents.chains)) {
      if (!chainFiles.addresses) continue;
      const data = fs.readFileSync(chainFiles.addresses, 'utf8');
      chainAddresses[chainName] = ChainAddressesSchema.parse(yamlParse(data));
    }
    return (this.addressCache = chainAddresses);
  }

  removeChain(chainName: ChainName): void {
    const chainFiles = this.listRegistryContent().chains[chainName];
    super.removeChain(chainName);
    this.removeFiles(Object.values(chainFiles));
  }

  protected listFiles(dirPath: string): string[] {
    if (!fs.existsSync(dirPath)) return [];

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const filePaths = entries.map((entry) => {
      const fullPath = path.join(dirPath, entry.name);
      return entry.isDirectory() ? this.listFiles(fullPath) : fullPath;
    });

    return filePaths.flat();
  }

  addWarpRoute(config: WarpCoreConfig): void {
    let { configPath, addressesPath } = this.getWarpArtifactsPaths(config);

    configPath = path.join(this.uri, configPath);
    this.createFile({ filePath: configPath, data: toYamlString(config, SCHEMA_REF) });

    addressesPath = path.join(this.uri, addressesPath);
    const addresses = warpConfigToWarpAddresses(config);
    this.createFile({ filePath: addressesPath, data: toYamlString(addresses) });
  }

  protected createOrUpdateChain(chain: {
    chainName: ChainName;
    metadata?: ChainMetadata;
    addresses?: ChainAddresses;
  }): void {
    if (!chain.metadata && !chain.addresses)
      throw new Error(`Chain ${chain.chainName} must have metadata or addresses, preferably both`);

    const currentChains = this.listRegistryContent();
    if (!currentChains.chains[chain.chainName]) {
      this.logger.debug(`Chain ${chain.chainName} not found in registry, adding it now`);
    }

    if (chain.metadata) {
      this.createChainFile(
        chain.chainName,
        'metadata',
        chain.metadata,
        this.getMetadata(),
        SCHEMA_REF,
      );
    }
    if (chain.addresses) {
      this.createChainFile(chain.chainName, 'addresses', chain.addresses, this.getAddresses());
    }
  }

  protected createChainFile(
    chainName: ChainName,
    fileName: keyof ChainFiles,
    data: any,
    cache: ChainMap<any>,
    prefix?: string,
  ) {
    const filePath = path.join(this.uri, this.getChainsPath(), chainName, `${fileName}.yaml`);
    const currentChains = this.listRegistryContent().chains;
    currentChains[chainName] ||= {};
    currentChains[chainName][fileName] = filePath;
    cache[chainName] = data;
    this.createFile({ filePath, data: toYamlString(data, prefix) });
  }

  protected createFile(file: { filePath: string; data: string }): void {
    const dirPath = path.dirname(file.filePath);
    if (!fs.existsSync(dirPath))
      fs.mkdirSync(dirPath, {
        recursive: true,
      });
    fs.writeFileSync(file.filePath, file.data);
  }

  protected removeFiles(filePaths: string[]): void {
    for (const filePath of filePaths) {
      fs.unlinkSync(filePath);
    }
    const parentDir = path.dirname(filePaths[0]);
    if (fs.readdirSync(parentDir).length === 0) {
      fs.rmdirSync(parentDir);
    }
  }
}
