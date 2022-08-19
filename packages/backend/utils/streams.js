require("dotenv").config();
const ethers = require("ethers");
const fs = require("fs");
const db = require("../services/db/db");

const ABI_PATH = "./abi/SimpleStream.json";
const SIMPLE_STREAM_ABI = JSON.parse(fs.readFileSync(ABI_PATH, "utf8"));

/**
 * Retrieve a list of deposit/withdraw events for the given `streamAddress`.
 *
 * @param provider A connected ethersjs provider
 * @param stream Stream info for which events will be received
 * @param fromBlock Begin searching from this block number
 * @param toBlock Search up to this block number
 * @return {Promise<{balance: string, streamAddress, events: {type: string, payload: object}[]}>}
 */
const getStreamEvents = async (provider, stream, fromBlock = 0, toBlock) => {
  const streamAddress = stream.streamAddress;
  const streamContract = new ethers.Contract(streamAddress, SIMPLE_STREAM_ABI, provider);

  let cap = stream.cap;
  let frequency = stream.frequency;
  if (!cap || !frequency) {
    cap = ethers.utils.formatEther(await streamContract.cap());
    frequency = Number(ethers.utils.formatUnits(await streamContract.frequency(), 0));
  }

  // Events
  const withdrawFilter = streamContract.filters.Withdraw();
  withdrawFilter.fromBlock = fromBlock;
  withdrawFilter.toBlock = toBlock;
  const withdrawLogs = await provider.getLogs(withdrawFilter);
  const depositFilter = streamContract.filters.Deposit();
  depositFilter.fromBlock = fromBlock;
  depositFilter.toBlock = toBlock;
  const depositLogs = await provider.getLogs(depositFilter);

  const withdrawEvents = await Promise.all(
    withdrawLogs.map(async log => {
      const data = streamContract.interface.parseLog(log);
      const block = await provider.getBlock(log.blockNumber);
      return {
        type: "stream.withdraw",
        timestamp: block.timestamp * 1000,
        payload: {
          userAddress: data.args.to,
          amount: ethers.utils.formatEther(data.args.amount),
          reason: data.args.reason,
          block: log.blockNumber,
          tx: log.transactionHash,
          streamAddress,
        },
      };
    }),
  );

  let lastContract = stream.lastContract;
  if (withdrawEvents.length) {
    lastContract = Number(ethers.utils.formatUnits(await streamContract.last(), 0));
  }

  const depositEvents = await Promise.all(
    depositLogs.map(async log => {
      const data = streamContract.interface.parseLog(log);
      const block = await provider.getBlock(log.blockNumber);
      return {
        type: "stream.deposit",
        timestamp: block.timestamp * 1000,
        payload: {
          userAddress: data.args.from,
          builderAddress: stream.builderAddress,
          amount: ethers.utils.formatEther(data.args.amount),
          reason: data.args.reason,
          block: log.blockNumber,
          tx: log.transactionHash,
          streamAddress,
        },
      };
    }),
  );

  return {
    streamAddress,
    lastContract,
    cap,
    frequency,
    lastBlock: toBlock,
    balance: ethers.utils.formatEther(await provider.getBalance(streamAddress)),
    events: [...withdrawEvents, ...depositEvents],
  };
};

const updateStreamsForBuilders = async (max = null) => {
  const maxItems = Number(max) || 100;
  const provider = new ethers.providers.StaticJsonRpcProvider(process.env.RPC_URL);
  const currentBlock = await provider.getBlockNumber();
  const streams = await db.findUpdatableStreams({ limit: maxItems });
  let updated = 0;

  const updates = streams.map(async stream => {
    const fromBlock = stream.lastIndexedBlock ?? 0;

    return [await getStreamEvents(provider, stream, fromBlock + 1, currentBlock), stream];
  });

  return Promise.all(updates)
    .then(async streamsResult => {
      await Promise.all(
        streamsResult.map(async ([streamUpdate, stream]) => {
          if (streamUpdate.events.length) {
            console.log("Updating stream data for", stream.builderAddress);
            await db.updateStreamData(stream, streamUpdate);
            updated += 1;
          } else if (!stream.lastIndexedBlock) {
            // New stream => set data even it doesn't have an event.
            console.log("Updating NEW stream data for", stream.builderAddress);
            await db.updateStreamData(stream, streamUpdate);
            updated += 1;
          }
        }),
      );
      // Not using it right now, but keeping it up to date.
      console.log("Updating stream lastIndexedBlock", currentBlock);
      await db.setConfigData("streams", { lastIndexedBlock: currentBlock });
      return updated;
    })
    .catch(e => {
      console.error("Error found. Not updating lastIndexedBlock", e);
      throw new Error(e);
    });
};

module.exports = {
  getStreamEvents,
  updateStreamsForBuilders,
};
