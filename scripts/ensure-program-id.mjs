import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keygen = path.join(root, ".tools/solana/active_release/bin/solana-keygen");
const keypairPath = path.join(root, "target/deploy/callwindow_escrow-keypair.json");
const programPath = path.join(root, "programs/callwindow-escrow/src/lib.rs");
const anchorPath = path.join(root, "Anchor.toml");

await mkdir(path.dirname(keypairPath), { recursive: true, mode: 0o700 });
try {
  await readFile(keypairPath, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  execFileSync(keygen, ["new", "--no-bip39-passphrase", "--silent", "--outfile", keypairPath], {
    cwd: root,
    stdio: "ignore",
  });
}

const programId = execFileSync(keygen, ["pubkey", keypairPath], { cwd: root, encoding: "utf8" }).trim();
const programSource = await readFile(programPath, "utf8");
const anchorConfig = await readFile(anchorPath, "utf8");
const idDeclaration = /^declare_id!\("[1-9A-HJ-NP-Za-km-z]+"\);$/m;
const anchorId = /^callwindow_escrow = "[1-9A-HJ-NP-Za-km-z]+"$/gm;

if (!idDeclaration.test(programSource)) throw new Error("Expected exactly one Rust declare_id! entry.");
const configuredIds = [...anchorConfig.matchAll(anchorId)];
if (configuredIds.length !== 2) throw new Error("Expected localnet and devnet program IDs in Anchor.toml.");

const nextProgramSource = programSource.replace(idDeclaration, `declare_id!("${programId}");`);
const nextAnchorConfig = anchorConfig.replace(anchorId, `callwindow_escrow = "${programId}"`);
if (nextProgramSource !== programSource) await writeFile(programPath, nextProgramSource);
if (nextAnchorConfig !== anchorConfig) await writeFile(anchorPath, nextAnchorConfig);
console.log(`Program ID synchronized with the ignored local keypair: ${programId}`);
