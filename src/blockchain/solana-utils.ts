import {
  Connection,
  PublicKey,
  Transaction,
  TransactionSignature,
  AccountInfo,
  ParsedAccountData,
  GetProgramAccountsConfig,
  Commitment,
  ConfirmedTransactionMeta,
  ParsedTransactionWithMeta,
  SignatureResult,
  TokenAmount,
  Finality,
} from '@solana/web3.js';

export interface AccountData {
  address: string;
  data: AccountInfo<Buffer | ParsedAccountData> | null;
}

export interface TokenAccountInfo {
  address: string;
  mint: string;
  owner: string;
  amount: string;
  decimals: number;
}

export interface TransactionResult {
  signature: string;
  slot: number;
  confirmationStatus: Finality;
  err: any;
  logs?: string[];
}

export class SolanaUtils {
  constructor(private connection: Connection) {}

  /**
   * Get account information
   */
  async getAccountInfo(
    publicKey: PublicKey | string,
    commitment?: Commitment,
  ): Promise<AccountInfo<Buffer> | null> {
    const pubkey = typeof publicKey === 'string' ? new PublicKey(publicKey) : publicKey;
    return await this.connection.getAccountInfo(pubkey, commitment);
  }

  /**
   * Get parsed account information
   */
  async getParsedAccountInfo(
    publicKey: PublicKey | string,
    commitment?: Commitment,
  ): Promise<AccountInfo<ParsedAccountData | Buffer> | null> {
    const pubkey = typeof publicKey === 'string' ? new PublicKey(publicKey) : publicKey;
    const response = await this.connection.getParsedAccountInfo(pubkey, commitment);
    return response.value;
  }

  /**
   * Get multiple accounts in a single request
   */
  async getMultipleAccounts(
    publicKeys: (PublicKey | string)[],
    commitment?: Commitment,
  ): Promise<AccountData[]> {
    const pubkeys = publicKeys.map(pk => (typeof pk === 'string' ? new PublicKey(pk) : pk));

    const response = await this.connection.getMultipleAccountsInfo(pubkeys, commitment);

    return response.map((accountInfo, index) => ({
      address: pubkeys[index].toString(),
      data: accountInfo,
    }));
  }

  /**
   * Get program accounts
   */
  async getProgramAccounts(
    programId: PublicKey | string,
    config?: GetProgramAccountsConfig,
  ): Promise<AccountData[]> {
    const pubkey = typeof programId === 'string' ? new PublicKey(programId) : programId;
    const accounts = await this.connection.getProgramAccounts(pubkey, config);

    return accounts.map(account => ({
      address: account.pubkey.toString(),
      data: account.account,
    }));
  }

  /**
   * Get token accounts by owner
   */
  async getTokenAccountsByOwner(
    owner: PublicKey | string,
    filter?: { mint?: PublicKey | string; programId?: PublicKey | string },
    commitment?: Commitment,
  ): Promise<TokenAccountInfo[]> {
    const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner;

    const filterConfig: any = {};
    if (filter?.mint) {
      filterConfig.mint =
        typeof filter.mint === 'string' ? new PublicKey(filter.mint) : filter.mint;
    } else if (filter?.programId) {
      filterConfig.programId =
        typeof filter.programId === 'string' ? new PublicKey(filter.programId) : filter.programId;
    }

    const response = await this.connection.getParsedTokenAccountsByOwner(
      ownerPubkey,
      filterConfig,
      commitment,
    );

    return response.value.map(accountInfo => {
      const parsed = accountInfo.account.data.parsed;
      return {
        address: accountInfo.pubkey.toString(),
        mint: parsed.info.mint,
        owner: parsed.info.owner,
        amount: parsed.info.tokenAmount.amount,
        decimals: parsed.info.tokenAmount.decimals,
      };
    });
  }

  /**
   * Get transaction details
   */
  async getTransaction(
    signature: string,
    commitment?: Commitment,
  ): Promise<ParsedTransactionWithMeta | null> {
    return await this.connection.getParsedTransaction(signature, {
      commitment: commitment as Finality,
      maxSupportedTransactionVersion: 0,
    });
  }

  /**
   * Get multiple transactions
   */
  async getTransactions(
    signatures: string[],
    commitment?: Commitment,
  ): Promise<(ParsedTransactionWithMeta | null)[]> {
    const promises = signatures.map(sig => this.getTransaction(sig, commitment));
    return await Promise.all(promises);
  }

  /**
   * Send and confirm transaction
   */
  async sendAndConfirmTransaction(
    transaction: Transaction,
    commitment: Commitment = 'confirmed',
  ): Promise<TransactionResult> {
    const signature = await this.connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: commitment,
    });

    const confirmation = await this.connection.confirmTransaction(signature, commitment);

    const result: TransactionResult = {
      signature,
      slot: confirmation.context.slot,
      confirmationStatus: commitment as Finality,
      err: confirmation.value.err,
    };

    // Get transaction logs if available
    try {
      const tx = await this.getTransaction(signature, commitment);
      if (tx && tx.meta && tx.meta.logMessages) {
        result.logs = tx.meta.logMessages;
      }
    } catch (error) {
      // Ignore errors when fetching logs
    }

    return result;
  }

  /**
   * Wait for transaction confirmation
   */
  async waitForConfirmation(
    signature: string,
    commitment: Commitment = 'confirmed',
    timeout: number = 60000,
  ): Promise<SignatureResult> {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      try {
        const result = await this.connection.getSignatureStatus(signature);

        if (result.value) {
          const confirmationStatus = result.value.confirmationStatus;

          // Check if we've reached the desired commitment level
          if (
            commitment === 'processed' ||
            (commitment === 'confirmed' &&
              (confirmationStatus === 'confirmed' || confirmationStatus === 'finalized')) ||
            (commitment === 'finalized' && confirmationStatus === 'finalized')
          ) {
            return result.value;
          }
        }

        // Wait before checking again
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        // Continue waiting on error
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    throw new Error(`Transaction confirmation timeout after ${timeout}ms`);
  }

  /**
   * Get recent blockhash
   */
  async getLatestBlockhash(commitment?: Commitment) {
    return await this.connection.getLatestBlockhash(commitment);
  }

  /**
   * Get balance in lamports
   */
  async getBalance(publicKey: PublicKey | string, commitment?: Commitment): Promise<number> {
    const pubkey = typeof publicKey === 'string' ? new PublicKey(publicKey) : publicKey;
    return await this.connection.getBalance(pubkey, commitment);
  }

  /**
   * Get SOL balance in decimal format
   */
  async getSolBalance(publicKey: PublicKey | string, commitment?: Commitment): Promise<number> {
    const lamports = await this.getBalance(publicKey, commitment);
    return lamports / 1_000_000_000; // Convert lamports to SOL
  }

  /**
   * Get token supply information
   */
  async getTokenSupply(mint: PublicKey | string, commitment?: Commitment): Promise<TokenAmount> {
    const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
    const response = await this.connection.getTokenSupply(mintPubkey, commitment);
    return response.value;
  }

  /**
   * Subscribe to account changes
   */
  subscribeToAccount(
    publicKey: PublicKey | string,
    callback: (accountInfo: AccountInfo<Buffer>, context: { slot: number }) => void,
    commitment?: Commitment,
  ): number {
    const pubkey = typeof publicKey === 'string' ? new PublicKey(publicKey) : publicKey;
    return this.connection.onAccountChange(pubkey, callback, commitment);
  }

  /**
   * Subscribe to program account changes
   */
  subscribeToProgramAccounts(
    programId: PublicKey | string,
    callback: (
      keyedAccountInfo: { accountId: PublicKey; accountInfo: AccountInfo<Buffer> },
      context: { slot: number },
    ) => void,
    commitment?: Commitment,
    filters?: any[],
  ): number {
    const pubkey = typeof programId === 'string' ? new PublicKey(programId) : programId;
    return this.connection.onProgramAccountChange(pubkey, callback, commitment, filters);
  }

  /**
   * Subscribe to logs
   */
  subscribeToLogs(
    filter: 'all' | 'allWithVotes' | { mentions: string[] } | PublicKey,
    callback: (
      logs: { signature: string; err: any; logs: string[] },
      context: { slot: number },
    ) => void,
    commitment?: Commitment,
  ): number {
    return this.connection.onLogs(filter as any, callback, commitment);
  }

  /**
   * Unsubscribe from subscription
   */
  async unsubscribe(subscriptionId: number): Promise<void> {
    await this.connection.removeAccountChangeListener(subscriptionId);
  }

  /**
   * Check if an address is a valid Solana public key
   */
  static isValidPublicKey(address: string): boolean {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Convert string to PublicKey safely
   */
  static toPublicKey(address: string): PublicKey {
    if (!this.isValidPublicKey(address)) {
      throw new Error(`Invalid public key: ${address}`);
    }
    return new PublicKey(address);
  }
}
