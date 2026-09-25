import assert from "node:assert/strict";
import test from "node:test";
import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

test("installed web3 SDK sends versioned simulation config to the RPC layer", async () => {
  const connection = new Connection("http://127.0.0.1:8899", "finalized");
  const payer = Keypair.generate();
  const legacyTransaction = new Transaction().add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: payer.publicKey,
    lamports: 0,
  }));
  legacyTransaction.feePayer = payer.publicKey;
  legacyTransaction.recentBlockhash = Keypair.generate().publicKey.toString();

  let request;
  connection._rpcRequest = async (method, args) => {
    request = { method, args };
    return {
      jsonrpc: "2.0",
      id: "1",
      result: {
        context: { slot: 1 },
        value: { err: null, logs: [], accounts: null, unitsConsumed: 0, returnData: null },
      },
    };
  };

  const simulationTransaction = new VersionedTransaction(legacyTransaction.compileMessage());
  const result = await connection.simulateTransaction(simulationTransaction, { commitment: "confirmed" });

  assert.equal(result.value.err, null);
  assert.equal(request.method, "simulateTransaction");
  assert.equal(request.args.length, 2);
  assert.equal(request.args[1].encoding, "base64");
  assert.equal(request.args[1].commitment, "confirmed");
});
