import { MockContract, smockit } from "@eth-optimism/smock"
import { ethers } from "hardhat"
import { ClearingHouse, Exchange, InsuranceFund, TestERC20, UniswapV3Factory, Vault } from "../../typechain"
import { ADDR_LESS_THAN, mockedBaseTokenTo } from "../clearingHouse/fixtures"
import { tokensFixture } from "../shared/fixtures"

interface MockedClearingHouseFixture {
    exchange: Exchange
    mockedUniV3Factory: MockContract
    mockedQuoteToken: MockContract
    mockedBaseToken: MockContract
}

export async function mockedExchangeFixture(): Promise<MockedClearingHouseFixture> {
    const { token1 } = await tokensFixture()

    // deploy test tokens
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    const USDC = (await tokenFactory.deploy("TestUSDC", "USDC")) as TestERC20
    const vaultFactory = await ethers.getContractFactory("Vault")
    const vault = (await vaultFactory.deploy(USDC.address)) as Vault
    const insuranceFundFactory = await ethers.getContractFactory("InsuranceFund")
    const insuranceFund = (await insuranceFundFactory.deploy(vault.address)) as InsuranceFund

    const mockedQuoteToken = await smockit(token1)
    mockedQuoteToken.smocked.decimals.will.return.with(async () => {
        return 18
    })
    mockedQuoteToken.smocked.totalSupply.will.return.with(async () => {
        return ethers.constants.MaxUint256
    })

    const mockedVault = await smockit(vault)
    const mockedInsuranceFund = await smockit(insuranceFund)

    // deploy UniV3 factory
    const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
    const uniV3Factory = (await factoryFactory.deploy()) as UniswapV3Factory
    const mockedUniV3Factory = await smockit(uniV3Factory)

    // deploy clearingHouse
    const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
    const clearingHouse = (await clearingHouseFactory.deploy(
        mockedVault.address,
        mockedInsuranceFund.address,
        mockedQuoteToken.address,
        mockedUniV3Factory.address,
    )) as ClearingHouse
    await token1.mintMaximumTo(clearingHouse.address)

    const exchangeFactory = await ethers.getContractFactory("Exchange")
    const exchange = (await exchangeFactory.deploy(
        clearingHouse.address,
        mockedUniV3Factory.address,
        mockedQuoteToken.address,
    )) as Exchange

    // deployer ensure base token is always smaller than quote in order to achieve base=token0 and quote=token1
    const mockedBaseToken = await mockedBaseTokenTo(ADDR_LESS_THAN, mockedQuoteToken.address)
    mockedBaseToken.smocked.decimals.will.return.with(async () => {
        return 18
    })
    mockedBaseToken.smocked.balanceOf.will.return.with(async () => {
        return ethers.constants.MaxUint256
    })

    return {
        exchange,
        mockedUniV3Factory,
        mockedQuoteToken,
        mockedBaseToken,
    }
}
