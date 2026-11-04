/**
 * Tests for the "can this connection accept inbound traffic at all?" logic.
 *
 * This matters more than it looks. A router will happily accept a UPnP port
 * mapping while sitting behind carrier-grade NAT, so the app can create a
 * forwarding rule that appears to work and changes nothing. Comparing the
 * router's own WAN address against the address the internet sees is the only
 * way to tell the difference — and getting it wrong sends someone down a
 * router-configuration rabbit hole that cannot possibly end well.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyWanAddress } from '../server/lib/network.js';

test('a router holding a public address can forward ports', () => {
  const result = classifyWanAddress('203.0.113.7', '203.0.113.7');
  assert.equal(result.kind, 'direct');
  assert.equal(result.forwardingWorks, true);
});

test('carrier-grade NAT is detected and explained', () => {
  // The case that prompted this: a mobile/LTE router reporting an address in
  // the carrier-grade NAT range while the internet sees a different address.
  // Addresses are from the RFC 6598 and RFC 5737 documentation ranges.
  const result = classifyWanAddress('100.64.0.5', '198.51.100.42');
  assert.equal(result.kind, 'cgnat');
  assert.equal(result.forwardingWorks, false);
  assert.match(result.message, /carrier-grade NAT range/i);
  assert.ok(result.options.length >= 2, 'should offer real alternatives, not just "it failed"');
  assert.ok(
    result.options.some((o) => /public \(static\) IP/i.test(o)),
    'should mention asking the ISP',
  );
  assert.ok(
    result.options.some((o) => /tunnel|playit|tailscale/i.test(o)),
    'should mention a tunnel, which is the only thing that actually works',
  );
});

test('the whole 100.64.0.0/10 range counts as CGNAT', () => {
  for (const ip of ['100.64.0.1', '100.100.0.1', '100.127.255.254']) {
    assert.equal(classifyWanAddress(ip, '203.0.113.1').kind, 'cgnat', `${ip} should be CGNAT`);
  }
  // Just outside the range on either side.
  assert.notEqual(classifyWanAddress('100.63.255.255', '203.0.113.1').kind, 'cgnat');
  assert.notEqual(classifyWanAddress('100.128.0.0', '203.0.113.1').kind, 'cgnat');
});

test('a private WAN address means a second router upstream', () => {
  for (const ip of ['192.168.1.1', '10.0.0.1', '172.16.5.4']) {
    const result = classifyWanAddress(ip, '203.0.113.1');
    assert.equal(result.kind, 'double-nat', `${ip} should be double NAT`);
    assert.equal(result.forwardingWorks, false);
  }
});

test('a mismatched public address is reported as unexpected NAT', () => {
  const result = classifyWanAddress('198.51.100.9', '203.0.113.7');
  assert.equal(result.kind, 'nat');
  assert.equal(result.forwardingWorks, false);
});

test('an unknown WAN address is not treated as broken', () => {
  const result = classifyWanAddress(null, '203.0.113.7');
  assert.equal(result.kind, 'unknown');
  assert.equal(result.forwardingWorks, null, 'unknown must not be reported as failure');
});

test('a matching address with no public lookup still passes', () => {
  // The lookup can fail (offline, blocked); that alone must not block setup.
  const result = classifyWanAddress('203.0.113.7', null);
  assert.equal(result.kind, 'direct');
  assert.equal(result.forwardingWorks, true);
});
