# 🚀 Liquid-Snipe MVP Deployment Checklist

## Pre-Deployment Setup

### 1. System Requirements ✅
- [ ] Node.js 18+ installed
- [ ] TypeScript compiler installed
- [ ] Git repository cloned
- [ ] NPM dependencies installed (`npm install`)

### 2. Build Validation ✅
- [ ] Code compiles successfully (`npm run build`)
- [ ] No TypeScript errors
- [ ] All dependencies resolved
- [ ] Dist directory created

### 3. Configuration Setup 🔧

#### A. Environment Configuration
- [ ] Copy `config.example.yaml` to `config.yaml`
- [ ] Review and customize all configuration sections:

**Critical Settings to Review:**
```yaml
# RPC Configuration - Use reliable provider
rpc:
  httpUrl: "https://api.mainnet-beta.solana.com"  # Consider premium RPC
  wsUrl: "wss://api.mainnet-beta.solana.com"

# Wallet Configuration - CRITICAL SAFETY SETTINGS
wallet:
  riskPercent: 2  # START LOW (2-3%)
  maxTotalRiskPercent: 10  # CONSERVATIVE LIMIT
  confirmationRequired: false  # For automation

# Trading Configuration
tradeConfig:
  minLiquidityUsd: 10000  # Higher for safety
  maxSlippagePercent: 2   # Conservative
  defaultTradeAmountUsd: 50  # START SMALL
  maxTradeAmountUsd: 500     # CONSERVATIVE LIMIT

# Enable dry run initially
dryRun: true  # SET TO TRUE FOR INITIAL TESTING
```

#### B. API Keys Setup
- [ ] Obtain CoinGecko API key (optional for pro features)
- [ ] Obtain Birdeye API key for enhanced market data
- [ ] Configure rate limits appropriately

#### C. Database Configuration  
- [ ] Create data directory: `mkdir -p data/`
- [ ] Ensure proper permissions
- [ ] Configure backup settings

### 4. Wallet Security Setup 🔐

#### A. Wallet Generation
- [ ] Create secure trading wallet:
```bash
mkdir -p keys/
# Generate new keypair or import existing one
# Store as keys/trading-wallet.json
```

#### B. Security Validation
- [ ] Verify wallet file permissions (600 or 700)
- [ ] Ensure wallet is NOT the main holding wallet
- [ ] Fund with small test amount initially
- [ ] Backup wallet private key securely

#### C. Hardware Wallet (Optional)
- [ ] Configure Ledger or Trezor if preferred
- [ ] Test hardware wallet connectivity
- [ ] Verify signing process works

### 5. Notification Setup 📱

#### A. Telegram (Optional)
- [ ] Create Telegram bot token
- [ ] Get chat ID
- [ ] Configure in config.yaml:
```yaml
notifications:
  telegram:
    enabled: true
    botToken: "YOUR_BOT_TOKEN"
    chatId: "YOUR_CHAT_ID"
```

#### B. Discord (Optional)
- [ ] Create Discord webhook URL
- [ ] Configure in config.yaml:
```yaml
notifications:
  discord:
    enabled: true
    webhookUrl: "YOUR_WEBHOOK_URL"
```

---

## Deployment Process

### Phase 1: Dry Run Testing 🧪

1. **Initial Configuration:**
   - [ ] Set `dryRun: true` in config.yaml
   - [ ] Set conservative risk limits
   - [ ] Enable verbose logging

2. **Launch Dry Run:**
   ```bash
   npm start
   ```

3. **Validation Checks:**
   - [ ] Application starts without errors
   - [ ] RPC connection establishes successfully
   - [ ] Price feeds are working
   - [ ] Database initializes properly
   - [ ] TUI interface loads (if enabled)
   - [ ] Notifications are working

4. **Monitor for Issues:**
   - [ ] Run for at least 2 hours
   - [ ] Check logs for any errors or warnings
   - [ ] Verify pool detection is working
   - [ ] Confirm strategy evaluation is functioning

### Phase 2: Live Trading Preparation 🎯

1. **Final Configuration Review:**
   - [ ] Double-check all risk parameters
   - [ ] Verify wallet funding is appropriate
   - [ ] Confirm notification channels are working
   - [ ] Review exit strategies configuration

2. **Safety Checks:**
   - [ ] Confirm wallet balance is reasonable for testing
   - [ ] Verify risk percentages are conservative
   - [ ] Check that circuit breakers are enabled
   - [ ] Ensure stop-loss strategies are active

3. **Monitoring Setup:**
   - [ ] Set up real-time monitoring
   - [ ] Configure log aggregation if needed
   - [ ] Prepare incident response procedures

### Phase 3: Live Deployment 🚀

1. **Enable Live Trading:**
   ```bash
   # Edit config.yaml
   dryRun: false
   ```

2. **Launch Production:**
   ```bash
   npm start
   ```

3. **Immediate Verification:**
   - [ ] System starts successfully
   - [ ] Live trading mode confirmed
   - [ ] All connections established
   - [ ] Monitoring dashboards active

---

## Post-Deployment Monitoring

### First 24 Hours - Critical Monitoring 🔍

**Every 15 minutes for first 2 hours:**
- [ ] Check system status
- [ ] Monitor error rates
- [ ] Verify trades are executing properly
- [ ] Check wallet balance changes
- [ ] Monitor database size

**Every hour for remaining 22 hours:**
- [ ] Review trade performance
- [ ] Check for any stuck positions
- [ ] Monitor system resource usage
- [ ] Verify backup processes are working

### Ongoing Monitoring (Daily) 📊

#### Performance Metrics
- [ ] Trade success rate
- [ ] Average profit/loss per trade
- [ ] System uptime
- [ ] API response times
- [ ] Memory and CPU usage

#### Risk Metrics  
- [ ] Current portfolio exposure
- [ ] Open positions count
- [ ] Largest position size
- [ ] Risk per trade distribution
- [ ] Stop-loss trigger frequency

#### System Health
- [ ] Database size and growth
- [ ] Log file sizes
- [ ] Network connectivity
- [ ] API rate limit usage
- [ ] Error frequency and types

---

## Troubleshooting Guide

### Common Issues and Solutions

#### 1. RPC Connection Failures
```bash
# Check RPC endpoint health
curl -X POST [RPC_URL] -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'

# Solutions:
- Switch to backup RPC provider
- Check network connectivity
- Verify RPC endpoint is not rate limited
```

#### 2. Price Feed Issues
```bash
# Verify API endpoints
curl "https://api.coingecko.com/api/v3/ping"
curl "https://public-api.birdeye.so/public/price?address=So11111111111111111111111111111111111111112"

# Solutions:
- Check API keys are valid
- Verify rate limits not exceeded
- Switch to backup price feed
```

#### 3. Database Issues
```bash
# Check database file permissions
ls -la data/liquid-snipe.db

# Check database integrity
sqlite3 data/liquid-snipe.db "PRAGMA integrity_check;"

# Solutions:
- Restore from backup
- Recreate database (will lose history)
- Check disk space availability
```

#### 4. Wallet/Transaction Issues
```bash
# Check wallet balance
# Via application logs or RPC call

# Solutions:
- Verify wallet has sufficient SOL for gas
- Check private key is correct
- Verify wallet permissions
- Test with smaller amounts
```

---

## Emergency Procedures 🚨

### Immediate Shutdown
```bash
# Graceful shutdown
Ctrl+C (or kill process)

# Emergency stop (if needed)
killall -9 node
```

### Emergency Wallet Recovery
1. **Stop the application immediately**
2. **Secure the wallet private key**
3. **Transfer funds to secure wallet if needed**
4. **Investigate the issue before restarting**

### Data Recovery
1. **Stop the application**
2. **Restore from latest backup**
3. **Verify data integrity**
4. **Restart with dry run mode**
5. **Validate system before enabling live trading**

---

## Performance Optimization

### Resource Monitoring
```bash
# Monitor CPU and memory usage
top -p $(pgrep -f "liquid-snipe")

# Monitor network usage
netstat -i

# Monitor disk usage
df -h
```

### Optimization Tips
- **Database:** Vacuum database weekly
- **Memory:** Monitor for memory leaks
- **Network:** Use premium RPC endpoints for reliability
- **Logs:** Rotate logs regularly to prevent disk space issues

---

## Security Best Practices

### Wallet Security
- [ ] Never commit wallet private keys to git
- [ ] Use separate trading wallet, not main wallet
- [ ] Regular backup of wallet private keys
- [ ] Monitor wallet for unauthorized transactions

### API Security  
- [ ] Rotate API keys regularly
- [ ] Monitor API usage for anomalies
- [ ] Use environment variables for sensitive data
- [ ] Never expose API keys in logs

### System Security
- [ ] Keep Node.js and dependencies updated
- [ ] Monitor for security vulnerabilities
- [ ] Use secure RPC endpoints
- [ ] Regular system security updates

---

## Success Metrics

### Week 1 Goals 🎯
- [ ] **System Uptime:** > 95%
- [ ] **Trade Success Rate:** > 80%
- [ ] **Zero Critical Errors**
- [ ] **Risk Management:** Within configured limits
- [ ] **Profitability:** Break-even or positive

### Month 1 Goals 📈  
- [ ] **System Uptime:** > 99%
- [ ] **Trade Success Rate:** > 85%
- [ ] **Positive ROI**
- [ ] **Risk Management:** Optimal position sizing
- [ ] **Process Optimization:** Reduced manual monitoring

---

## Support and Maintenance

### Regular Maintenance Tasks
- **Daily:** Check system status and performance
- **Weekly:** Review trade performance and adjust strategies
- **Monthly:** Update dependencies and security patches
- **Quarterly:** Full system review and optimization

### Documentation Updates
- Keep deployment notes updated
- Document any configuration changes
- Maintain incident response logs
- Update troubleshooting guides based on experience

---

**Deployment Date:** _______________  
**Deployed By:** _______________  
**Initial Configuration:** _______________  
**Next Review Date:** _______________

**REMEMBER: Start conservative, monitor closely, and scale gradually!** 🚀