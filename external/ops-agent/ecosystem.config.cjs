module.exports = {
  apps: [{
    name: "ops-agent",
    script: "dist/index.js",
    cwd: "/opt/ops-agent",
    env: { NODE_ENV: "production" }
  }]
};
