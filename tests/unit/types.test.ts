/**
 * Unit tests for branded address types and type guards.
 *
 * Tests the accept/reject matrix for:
 * - isStrKeyAddress: valid/invalid StrKey addresses
 * - isContractAddress: contract addresses (C...) with valid/invalid formats
 * - isAccountAddress: account addresses (G...) with valid/invalid formats
 * - isPublicKeyHex: raw public keys in hex format
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isStrKeyAddress,
  isContractAddress,
  isAccountAddress,
  isPublicKeyHex,
} from "../../src/policy.ts";

describe("Type Guards", () => {
  describe("isStrKeyAddress", () => {
    it("should accept valid account addresses (G...)", () => {
      // Valid Stellar account addresses (56 characters: G + 55 Base32)
      const validAccountAddresses = [
        "GA6LHIWJKKNJWKJPJMDL4AOP6AHOGMSOGVYPMPTDU274YGYPD3US63HD",
        "GB25CRKTZNLCD4672INIEIOMT72SIIMAOAKCQJYBMRSCTYYLDIBMSNIT",
        "GBQ6534IKTU5JBJNKNWOIZCOKJULXVOERY2CCWH2GTDB4OK4QAK5KYLT",
      ];
      for (const addr of validAccountAddresses) {
        assert.ok(isStrKeyAddress(addr));
      }
    });

    it("should accept valid contract addresses (C...)", () => {
      // Valid Stellar contract addresses from Phase 2 fixture
      const validContractAddresses = [
        "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
        "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB",
      ];
      for (const addr of validContractAddresses) {
        assert.ok(isStrKeyAddress(addr));
      }
    });

    it("should reject empty strings", () => {
      assert.ok(!isStrKeyAddress(""));
    });

    it("should reject whitespace-only strings", () => {
      assert.ok(!isStrKeyAddress("   "));
    });

    it("should reject invalid prefixes", () => {
      assert.ok(
        !isStrKeyAddress("TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4"),
      );
      assert.ok(
        !isStrKeyAddress("XAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4"),
      );
    });

    it("should reject strings with invalid length", () => {
      assert.ok(
        !isStrKeyAddress("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
      );
      assert.ok(
        !isStrKeyAddress(
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4EXTRA",
        ),
      );
    });

    it("should reject non-string types", () => {
      assert.ok(!isStrKeyAddress(null));
      assert.ok(!isStrKeyAddress(undefined));
      assert.ok(!isStrKeyAddress(123));
      assert.ok(!isStrKeyAddress({ address: "GB..." }));
      assert.ok(!isStrKeyAddress([]));
    });

    it("should reject strings with invalid characters", () => {
      assert.ok(
        !isStrKeyAddress("GB7BDSOOQCFFVLZ37PF5LTQVLNCJYJ5ONUH3MBIUCUSD4B2LGYXJJP!"),
      );
      assert.ok(
        !isStrKeyAddress("GB7BDSOOQCFFVLZ37PF5LTQVLNCJYJ5ONUH3MBIUCUSD4B2LGYXJJP#"),
      );
    });
  });

  describe("isContractAddress", () => {
    it("should accept valid contract addresses (C...)", () => {
      const validContractAddresses = [
        "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
        "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB",
      ];
      for (const addr of validContractAddresses) {
        assert.ok(isContractAddress(addr));
      }
    });

    it("should reject account addresses (G...)", () => {
      const accountAddresses = [
        "GA6LHIWJKKNJWKJPJMDL4AOP6AHOGMSOGVYPMPTDU274YGYPD3US63HD",
        "GB25CRKTZNLCD4672INIEIOMT72SIIMAOAKCQJYBMRSCTYYLDIBMSNIT",
      ];
      for (const addr of accountAddresses) {
        assert.ok(!isContractAddress(addr));
      }
    });

    it("should reject invalid prefix", () => {
      assert.ok(
        !isContractAddress("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4"),
      );
      assert.ok(
        !isContractAddress("TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4"),
      );
    });

    it("should reject invalid length", () => {
      // Too short
      assert.ok(
        !isContractAddress("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
      );
      // Too long
      assert.ok(
        !isContractAddress(
          "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4EXTRA",
        ),
      );
    });

    it("should reject mixed case (contracts are case-sensitive)", () => {
      assert.ok(
        !isContractAddress(
          "ca7qkfukgmj5hghz6exw7h3ofukz5c5gn7nnfqn7n5npezrwwbqb7od",
        ),
      );
    });

    it("should reject non-string types", () => {
      assert.ok(!isContractAddress(null));
      assert.ok(!isContractAddress(undefined));
      assert.ok(!isContractAddress(123));
      assert.ok(!isContractAddress({ contract: "C..." }));
    });

    it("should reject empty strings", () => {
      assert.ok(!isContractAddress(""));
    });

    it("should reject strings with invalid characters", () => {
      assert.ok(
        !isContractAddress(
          "CA7QKFUKGMJ5HGHZ6EXW7H3OFUKZ5C5GN7NNFQN7N5NPEZRWWBQB7O!",
        ),
      );
    });
  });

  describe("isAccountAddress", () => {
    it("should accept valid account addresses (G...)", () => {
      const validAccountAddresses = [
        "GA6LHIWJKKNJWKJPJMDL4AOP6AHOGMSOGVYPMPTDU274YGYPD3US63HD",
        "GB25CRKTZNLCD4672INIEIOMT72SIIMAOAKCQJYBMRSCTYYLDIBMSNIT",
        "GBQ6534IKTU5JBJNKNWOIZCOKJULXVOERY2CCWH2GTDB4OK4QAK5KYLT",
      ];
      for (const addr of validAccountAddresses) {
        assert.ok(isAccountAddress(addr));
      }
    });

    it("should reject contract addresses (C...)", () => {
      const contractAddresses = [
        "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
        "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB",
      ];
      for (const addr of contractAddresses) {
        assert.ok(!isAccountAddress(addr));
      }
    });

    it("should reject invalid prefix", () => {
      assert.ok(
        !isAccountAddress(
          "CBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFN4L7MRJE47JREUMB5QFO6YL2",
        ),
      );
      assert.ok(
        !isAccountAddress(
          "TBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFN4L7MRJE47JREUMB5QFO6YL2",
        ),
      );
    });

    it("should reject invalid length", () => {
      // Too short
      assert.ok(
        !isAccountAddress(
          "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFN4L7MRJE47JREUMB5QFO6YL",
        ),
      );
      // Too long
      assert.ok(
        !isAccountAddress(
          "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFN4L7MRJE47JREUMB5QFO6YL2EXTRA",
        ),
      );
    });

    it("should reject mixed case", () => {
      assert.ok(
        !isAccountAddress(
          "gbrpyhil2ci3whzdtooqfc6eb4cgqofn4l7mrje47jreumb5qfo6yl2",
        ),
      );
    });

    it("should reject non-string types", () => {
      assert.ok(!isAccountAddress(null));
      assert.ok(!isAccountAddress(undefined));
      assert.ok(!isAccountAddress(123));
      assert.ok(!isAccountAddress({ account: "G..." }));
    });

    it("should reject empty strings", () => {
      assert.ok(!isAccountAddress(""));
    });

    it("should reject strings with invalid characters", () => {
      assert.ok(
        !isAccountAddress(
          "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFN4L7MRJE47JREUMB5QFO6YL!",
        ),
      );
    });
  });

  describe("isPublicKeyHex", () => {
    it("should accept valid 64-character hex strings", () => {
      const validHexKeys = [
        "0000000000000000000000000000000000000000000000000000000000000000",
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      ];
      for (const key of validHexKeys) {
        assert.ok(isPublicKeyHex(key));
      }
    });

    it("should accept mixed case hex strings", () => {
      assert.ok(
        isPublicKeyHex(
          "AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789",
        ),
      );
    });

    it("should reject strings shorter than 64 characters", () => {
      assert.ok(
        !isPublicKeyHex(
          "abcdef0123456789abcdef0123456789abcdef0123456789abcdef012345678",
        ),
      );
    });

    it("should reject strings longer than 64 characters", () => {
      assert.ok(
        !isPublicKeyHex(
          "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab",
        ),
      );
    });

    it("should reject strings with non-hex characters", () => {
      assert.ok(
        !isPublicKeyHex(
          "ghijkl0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        ),
      );
      assert.ok(
        !isPublicKeyHex(
          "abcdef0123456789abcdef0123456789abcdef0123456789abcdef012345678!",
        ),
      );
    });

    it("should reject non-string types", () => {
      assert.ok(!isPublicKeyHex(null));
      assert.ok(!isPublicKeyHex(undefined));
      assert.ok(!isPublicKeyHex(123));
      assert.ok(!isPublicKeyHex({ key: "..." }));
      assert.ok(!isPublicKeyHex([]));
    });

    it("should reject empty strings", () => {
      assert.ok(!isPublicKeyHex(""));
    });

    it("should reject whitespace", () => {
      assert.ok(!isPublicKeyHex("   "));
      assert.ok(
        !isPublicKeyHex(
          " abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        ),
      );
    });
  });

  describe("Type guard cross-validation (addressing wrong type usage)", () => {
    it("should distinguish contract address from account address", () => {
      const contractAddr = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
      const accountAddr = "GDCPT4Z3MBH7X6IX6A6BHIENUL7DRZ44O2SL2V72QJVOEJHJROP3PQDG";

      assert.ok(isContractAddress(contractAddr));
      assert.ok(!isAccountAddress(contractAddr));

      assert.ok(!isContractAddress(accountAddr));
      assert.ok(isAccountAddress(accountAddr));
    });

    it("should reject account address where contract is required", () => {
      const accountAddr = "GDCPT4Z3MBH7X6IX6A6BHIENUL7DRZ44O2SL2V72QJVOEJHJROP3PQDG";
      assert.ok(!isContractAddress(accountAddr));
    });

    it("should reject contract address where account is required", () => {
      const contractAddr = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
      assert.ok(!isAccountAddress(contractAddr));
    });

    it("should not confuse public key hex with StrKey addresses", () => {
      const publicKeyHex = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
      assert.ok(!isStrKeyAddress(publicKeyHex));
      assert.ok(isPublicKeyHex(publicKeyHex));
    });
  });

  describe("Edge cases and security", () => {
    it("should reject StrKey addresses with leading/trailing whitespace", () => {
      const validAddr = "GA6LHIWJKKNJWKJPJMDL4AOP6AHOGMSOGVYPMPTDU274YGYPD3US63HD";
      assert.ok(!isStrKeyAddress(` ${validAddr}`));
      assert.ok(!isStrKeyAddress(`${validAddr} `));
      assert.ok(!isStrKeyAddress(` ${validAddr} `));
    });

    it("should reject hex keys with leading zeros that don't make sense", () => {
      const validHex = "0000000000000000000000000000000000000000000000000000000000000000";
      const invalidPrefix = "00000000000000000000000000000000000000000000000000000000000000000";
      assert.ok(isPublicKeyHex(validHex));
      assert.ok(!isPublicKeyHex(invalidPrefix));
    });

    it("should be consistent across multiple calls", () => {
      const addr = "GA6LHIWJKKNJWKJPJMDL4AOP6AHOGMSOGVYPMPTDU274YGYPD3US63HD";
      assert.equal(isAccountAddress(addr), isAccountAddress(addr));
      assert.equal(isContractAddress(addr), isContractAddress(addr));
    });
  });
});
