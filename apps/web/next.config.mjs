/** @type {import('next').NextConfig} */
export default {
  // Workspace packages ship untranspiled ESM.
  transpilePackages: ['@retainer/chain', '@retainer/db'],
  eslint: { ignoreDuringBuilds: true },
};
