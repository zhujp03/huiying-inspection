const requiredMajor = 24;
const actualMajor = Number(process.versions.node.split(".")[0]);

if (actualMajor !== requiredMajor) {
  throw new Error(`Node.js ${requiredMajor}.x is required; found ${process.versions.node}. Use the version declared in .nvmrc.`);
}

console.log(`Node.js ${process.versions.node}: supported runtime`);
