/** @type {import('next').NextConfig} */
module.exports = {
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true },
  webpack: (config, { isServer, webpack }) => {
    if (!isServer) {
      // @solana/web3.js expects node globals that the browser bundle has to supply.
      config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, os: false, crypto: false, stream: false };
      config.plugins.push(new webpack.ProvidePlugin({ Buffer: ['buffer', 'Buffer'] }));
    }
    return config;
  },
};
