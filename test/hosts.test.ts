import assert from "node:assert/strict"
import test from "node:test"
import { hostsFrom } from "../src/hosts.ts"

const settings = {
  desktopHosts: [
    {
      id: "vps-id",
      label: "build",
      url: "https://build.example.com/",
      apiUrl: "https://api.build.example.com/",
      clientToken: "oc_client_abc",
    },
    {
      id: "relay-id",
      label: "laptop",
      url: "relay://server-id",
      clientToken: "oc_client_def",
    },
    {
      id: "plain-id",
      label: "Plain",
      url: "https://plain.example.com/",
      clientToken: "oc_client_ghi",
    },
  ],
}

test("uses apiUrl first and trims the trailing slash", () => {
  const [vps] = hostsFrom(settings, undefined)
  assert.equal(vps.id, "vps-id")
  assert.equal(vps.label, "build")
  assert.equal(vps.apiUrl, "https://api.build.example.com")
  assert.equal(vps.token, "oc_client_abc")
  assert.equal(vps.reason, undefined)
})

test("falls back to url when it is http", () => {
  const plain = hostsFrom(settings, undefined).find((host) => host.id === "plain-id")!
  assert.equal(plain.apiUrl, "https://plain.example.com")
})

test("marks a relay-only host unusable instead of dropping it", () => {
  const relay = hostsFrom(settings, undefined).find((host) => host.id === "relay-id")!
  assert.equal(relay.apiUrl, null)
  assert.match(relay.reason!, /relay/)
})

test("marks a host without a token unusable", () => {
  const hosts = hostsFrom({ desktopHosts: [{ id: "x", label: "X", url: "http://x.example" }] }, undefined)
  assert.equal(hosts[0].token, null)
  assert.match(hosts[0].reason!, /token/)
})

test("remote-hosts.json adds hosts and overrides the same id", () => {
  const hosts = hostsFrom(settings, {
    hosts: [
      { id: "vps-id", label: "build renamed", apiUrl: "http://192.0.2.20:8761", token: "oc_client_zzz" },
      { id: "extra", label: "Extra", apiUrl: "http://extra.example:1", token: "t" },
    ],
  })
  const vps = hosts.find((host) => host.id === "vps-id")!
  assert.equal(vps.label, "build renamed")
  assert.equal(vps.token, "oc_client_zzz")
  assert.ok(hosts.some((host) => host.id === "extra"))
})

test("ignores entries without an id or label", () => {
  assert.deepEqual(hostsFrom({ desktopHosts: [{ apiUrl: "http://x" }] }, undefined), [])
})
