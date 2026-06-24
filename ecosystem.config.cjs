module.exports = {
  apps: [
    {
      name: "http-tunnel-server",
      cwd: __dirname,
      script: "apps/server/src/index.js",
      interpreter: "node",
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "http-tunnel-client",
      cwd: __dirname,
      script: "apps/client/src/index.js",
      interpreter: "node",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
