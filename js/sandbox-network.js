/** Convert editable rows to the wire format; destination policy stays server-side. */
export function sandboxNetworkEntries(rows) {
  return rows.map(({ ip, port }, index) => {
    const address = ip.trim();
    if (!address) throw new Error(`Entry ${index + 1}: enter an IPv4 address`);
    const value = String(port).trim();
    const number = Number(value);
    if (!/^\d+$/.test(value) || !Number.isInteger(number) || number < 1 || number > 65535) {
      throw new Error(`Entry ${index + 1}: TCP port must be an integer from 1 to 65535`);
    }
    return { ip: address, port: number };
  });
}
