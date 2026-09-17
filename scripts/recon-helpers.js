import config from '../src/config.js';
import { ArofloClient } from '../src/aroflo/client.js';

export function createReconClient() {
  const { baseUrl, secretKey, uEncoded, pEncoded, orgEncoded, hostIp } = config.aroflo;
  return new ArofloClient({ baseUrl, secretKey, uEncoded, pEncoded, orgEncoded, hostIp });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function firstArray(response) {
  return Object.values(response || {}).find(Array.isArray) || [];
}
