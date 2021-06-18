import { MockContract, smockit } from "@eth-optimism/smock"
import { ethers } from "hardhat"
import { ClearingHouse, TestERC20, TestUniswapV3Broker, UniswapV3Factory } from "../../typechain"
import { uniswapV3FactoryFixture } from "../shared/fixtures"

interface ClearingHouseFixture {
    clearingHouse: ClearingHouse
    uniV3Factory: UniswapV3Factory
    vUSDC: TestERC20
    USDC: TestERC20
    baseToken: TestERC20
}

interface UniswapV3BrokerFixture {
    uniswapV3Broker: TestUniswapV3Broker
}

export async function clearingHouseFixture(): Promise<ClearingHouseFixture> {
    // deploy test tokens
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    const vUSDC = (await tokenFactory.deploy("vTestUSDC", "vUSDC")) as TestERC20
    const USDC = (await tokenFactory.deploy("TestUSDC", "USDC")) as TestERC20

    // deploy UniV3 factory
    const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
    const uniV3Factory = (await factoryFactory.deploy()) as UniswapV3Factory

    // deploy clearingHouse
    const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
    const clearingHouse = await clearingHouseFactory.deploy(USDC.address, vUSDC.address, uniV3Factory.address)
    const baseToken = await deployERC20()

    return { clearingHouse, uniV3Factory, vUSDC, USDC, baseToken }
}

export async function uniswapV3BrokerFixture(): Promise<UniswapV3BrokerFixture> {
    const factory = await uniswapV3FactoryFixture()
    const uniswapV3BrokerFactory = await ethers.getContractFactory("TestUniswapV3Broker")
    const uniswapV3Broker = (await uniswapV3BrokerFactory.deploy(factory.address)) as TestUniswapV3Broker
    return { uniswapV3Broker }
}

interface MockedClearingHouseFixture {
    clearingHouse: ClearingHouse
    mockedUniV3Factory: MockContract
    mockedVUSDC: MockContract
    mockedUSDC: MockContract
    mockedBaseToken: MockContract
}

export async function mockedClearingHouseFixture(): Promise<MockedClearingHouseFixture> {
    // deploy test tokens
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    const vUSDC = (await tokenFactory.deploy("vTestUSDC", "vUSDC")) as TestERC20
    const USDC = (await tokenFactory.deploy("TestUSDC", "USDC")) as TestERC20
    const mockedVUSDC = await smockit(vUSDC)
    const mockedUSDC = await smockit(USDC)

    // deploy UniV3 factory
    const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
    const uniV3Factory = (await factoryFactory.deploy()) as UniswapV3Factory
    const mockedUniV3Factory = await smockit(uniV3Factory)

    // deploy clearingHouse
    const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
    const clearingHouse = await clearingHouseFactory.deploy(
        mockedUSDC.address,
        mockedVUSDC.address,
        mockedUniV3Factory.address,
    )
    const baseToken = await deployERC20()
    const mockedBaseToken = await smockit(baseToken)

    return { clearingHouse, mockedUniV3Factory, mockedVUSDC, mockedUSDC, mockedBaseToken }
}

export async function deployERC20(): Promise<TestERC20> {
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    return (await tokenFactory.deploy("Test", "Test")) as TestERC20
}