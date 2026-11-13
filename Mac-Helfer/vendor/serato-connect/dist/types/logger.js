"use strict";
/**
 * @fileoverview Logger interface for serato-connect.
 * Allows consumers to inject their own logger implementation.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.noopLogger = void 0;
exports.noopLogger = {
    trace() { },
    debug() { },
    info() { },
    warn() { },
    error() { },
};
//# sourceMappingURL=logger.js.map