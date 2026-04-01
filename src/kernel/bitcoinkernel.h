// Copyright (c) 2024-present The Synorix Core developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#ifndef BITCOIN_KERNEL_BITCOINKERNEL_H
#define BITCOIN_KERNEL_BITCOINKERNEL_H

#ifndef __cplusplus
#include <stddef.h>
#include <stdint.h>
#else
#include <cstddef>
#include <cstdint>
#endif // __cplusplus

#ifndef BITCOINKERNEL_API
    #ifdef BITCOINKERNEL_BUILD
        #if defined(_WIN32)
            #define BITCOINKERNEL_API __declspec(dllexport)
        #else
            #define BITCOINKERNEL_API __attribute__((visibility("default")))
        #endif
    #else
        #if defined(_WIN32) && !defined(BITCOINKERNEL_STATIC)
            #define BITCOINKERNEL_API __declspec(dllimport)
        #else
            #define BITCOINKERNEL_API
        #endif
    #endif
#endif

/* Warning attributes */
#if defined(__GNUC__)
    #define BITCOINKERNEL_WARN_UNUSED_RESULT __attribute__((__warn_unused_result__))
#else
    #define BITCOINKERNEL_WARN_UNUSED_RESULT
#endif

/**
 * BITCOINKERNEL_ARG_NONNULL is a compiler attribute used to indicate that
 * certain pointer arguments to a function are not expected to be null.
 *
 * Callers must not pass a null pointer for arguments marked with this attribute,
 * as doing so may result in undefined behavior. This attribute should only be
 * used for arguments where a null pointer is unambiguously a programmer error,
 * such as for opaque handles, and not for pointers to raw input data that might
 * validly be null (e.g., from an empty std::span or std::string).
 */
#if !defined(BITCOINKERNEL_BUILD) && defined(__GNUC__)
    #define BITCOINKERNEL_ARG_NONNULL(...) __attribute__((__nonnull__(__VA_ARGS__)))
#else
    #define BITCOINKERNEL_ARG_NONNULL(...)
#endif

#ifdef __cplusplus
extern "C" {
#endif // __cplusplus

/**
 * @page remarks Remarks
 *
 * @section purpose Purpose
 *
 * This header currently exposes an API for interacting with parts of Synorix
 * Core's consensus code. Users can validate blocks, iterate the block index,
 * read block and undo data from disk, and validate scripts. The header is
 * unversioned and not stable yet. Users should expect breaking changes. It is
 * also not yet included in releases of Synorix Core.
 *
 * @section context Context
 *
 * The library provides a built-in static constant kernel context. This static
 * context offers only limited functionality. It detects and self-checks the
 * correct sha256 implementation, initializes the random number generator and
 * self-checks the secp256k1 static context. It is used internally for
 * otherwise "context-free" operations. This means that the user is not
 * required to initialize their own context before using the library.
 *
 * The user should create their own context for passing it to state-rich validation
 * functions and holding callbacks for kernel events.
 *
 * @section error Error handling
 *
 * Functions communicate an error through their return types, usually returning
 * a nullptr or a status code as documented by the returning function.
 * Additionally, verification functions, e.g. for scripts, may communicate more
 * detailed error information through status code out parameters.
 *
 * Fine-grained validation information is communicated through the validation
 * interface.
 *
 * The kernel notifications issue callbacks for errors. These are usually
 * indicative of a system error. If such an error is issued, it is recommended
 * to halt and tear down the existing kernel objects. Remediating the error may
 * require system intervention by the user.
 *
 * @section pointer Pointer and argument conventions
 *
 * The user is responsible for de-allocating the memory owned by pointers
 * returned by functions. Typically pointers returned by *_create(...) functions
 * can be de-allocated by corresponding *_destroy(...) functions.
 *
 * A function that takes pointer arguments makes no assumptions on their
 * lifetime. Once the function returns the user can safely de-allocate the
 * passed in arguments.
 *
 * Const pointers represent views, and do not transfer ownership. Lifetime
 * guarantees of these objects are described in the respective documentation.
 * Ownership of these resources may be taken by copying. They are typically
 * used for iteration with minimal overhead and require some care by the
 * programmer that their lifetime is not extended beyond that of the original
 * object.
 *
 * Array lengths follow the pointer argument they describe.
 */

/**
 * Opaque data structure for holding a transaction.
 */
typedef struct snrxk_Transaction snrxk_Transaction;

/**
 * Opaque data structure for holding a script pubkey.
 */
typedef struct snrxk_ScriptPubkey snrxk_ScriptPubkey;

/**
 * Opaque data structure for holding a transaction output.
 */
typedef struct snrxk_TransactionOutput snrxk_TransactionOutput;

/**
 * Opaque data structure for holding a logging connection.
 *
 * The logging connection can be used to manually stop logging.
 *
 * Messages that were logged before a connection is created are buffered in a
 * 1MB buffer. Logging can alternatively be permanently disabled by calling
 * @ref snrxk_logging_disable. Functions changing the logging settings are
 * global and change the settings for all existing snrxk_LoggingConnection
 * instances.
 */
typedef struct snrxk_LoggingConnection snrxk_LoggingConnection;

/**
 * Opaque data structure for holding the chain parameters.
 *
 * These are eventually placed into a kernel context through the kernel context
 * options. The parameters describe the properties of a chain, and may be
 * instantiated for either mainnet, testnet, signet, or regtest.
 */
typedef struct snrxk_ChainParameters snrxk_ChainParameters;

/**
 * Opaque data structure for holding options for creating a new kernel context.
 *
 * Once a kernel context has been created from these options, they may be
 * destroyed. The options hold the notification and validation interface
 * callbacks as well as the selected chain type until they are passed to the
 * context. If no options are configured, the context will be instantiated with
 * no callbacks and for mainnet. Their content and scope can be expanded over
 * time.
 */
typedef struct snrxk_ContextOptions snrxk_ContextOptions;

/**
 * Opaque data structure for holding a kernel context.
 *
 * The kernel context is used to initialize internal state and hold the chain
 * parameters and callbacks for handling error and validation events. Once
 * other validation objects are instantiated from it, the context is kept in
 * memory for the duration of their lifetimes.
 *
 * The processing of validation events is done through an internal task runner
 * owned by the context. It passes events through the registered validation
 * interface callbacks.
 *
 * A constructed context can be safely used from multiple threads.
 */
typedef struct snrxk_Context snrxk_Context;

/**
 * Opaque data structure for holding a block tree entry.
 *
 * This is a pointer to an element in the block index currently in memory of
 * the chainstate manager. It is valid for the lifetime of the chainstate
 * manager it was retrieved from. The entry is part of a tree-like structure
 * that is maintained internally. Every entry, besides the genesis, points to a
 * single parent. Multiple entries may share a parent, thus forming a tree.
 * Each entry corresponds to a single block and may be used to retrieve its
 * data and validation status.
 */
typedef struct snrxk_BlockTreeEntry snrxk_BlockTreeEntry;

/**
 * Opaque data structure for holding options for creating a new chainstate
 * manager.
 *
 * The chainstate manager options are used to set some parameters for the
 * chainstate manager.
 */
typedef struct snrxk_ChainstateManagerOptions snrxk_ChainstateManagerOptions;

/**
 * Opaque data structure for holding a chainstate manager.
 *
 * The chainstate manager is the central object for doing validation tasks as
 * well as retrieving data from the chain. Internally it is a complex data
 * structure with diverse functionality.
 *
 * Its functionality will be more and more exposed in the future.
 */
typedef struct snrxk_ChainstateManager snrxk_ChainstateManager;

/**
 * Opaque data structure for holding a block.
 */
typedef struct snrxk_Block snrxk_Block;

/**
 * Opaque data structure for holding the state of a block during validation.
 *
 * Contains information indicating whether validation was successful, and if not
 * which step during block validation failed.
 */
typedef struct snrxk_BlockValidationState snrxk_BlockValidationState;

/**
 * Opaque data structure for holding the currently known best-chain associated
 * with a chainstate.
 */
typedef struct snrxk_Chain snrxk_Chain;

/**
 * Opaque data structure for holding a block's spent outputs.
 *
 * Contains all the previous outputs consumed by all transactions in a specific
 * block. Internally it holds a nested vector. The top level vector has an
 * entry for each transaction in a block (in order of the actual transactions
 * of the block and without the coinbase transaction). This is exposed through
 * @ref snrxk_TransactionSpentOutputs. Each snrxk_TransactionSpentOutputs is in
 * turn a vector of all the previous outputs of a transaction (in order of
 * their corresponding inputs).
 */
typedef struct snrxk_BlockSpentOutputs snrxk_BlockSpentOutputs;

/**
 * Opaque data structure for holding a transaction's spent outputs.
 *
 * Holds the coins consumed by a certain transaction. Retrieved through the
 * @ref snrxk_BlockSpentOutputs. The coins are in the same order as the
 * transaction's inputs consuming them.
 */
typedef struct snrxk_TransactionSpentOutputs snrxk_TransactionSpentOutputs;

/**
 * Opaque data structure for holding a coin.
 *
 * Holds information on the @ref snrxk_TransactionOutput held within,
 * including the height it was spent at and whether it is a coinbase output.
 */
typedef struct snrxk_Coin snrxk_Coin;

/**
 * Opaque data structure for holding a block hash.
 *
 * This is a type-safe identifier for a block.
 */
typedef struct snrxk_BlockHash snrxk_BlockHash;

/**
 * Opaque data structure for holding a transaction input.
 *
 * Holds information on the @ref snrxk_TransactionOutPoint held within.
 */
typedef struct snrxk_TransactionInput snrxk_TransactionInput;

/**
 * Opaque data structure for holding a transaction out point.
 *
 * Holds the txid and output index it is pointing to.
 */
typedef struct snrxk_TransactionOutPoint snrxk_TransactionOutPoint;

/**
 * Opaque data structure for holding precomputed transaction data.
 *
 * Reusable when verifying multiple inputs of the same transaction.
 * This avoids recomputing transaction hashes for each input.
 *
 * Required when verifying a taproot input.
 */
typedef struct snrxk_PrecomputedTransactionData snrxk_PrecomputedTransactionData;

/**
 * Opaque data structure for holding a snrxk_Txid.
 *
 * This is a type-safe identifier for a transaction.
 */
typedef struct snrxk_Txid snrxk_Txid;

/**
 * Opaque data structure for holding a snrxk_BlockHeader.
 */
typedef struct snrxk_BlockHeader snrxk_BlockHeader;

/** Current sync state passed to tip changed callbacks. */
typedef uint8_t snrxk_SynchronizationState;
#define snrxk_SynchronizationState_INIT_REINDEX ((snrxk_SynchronizationState)(0))
#define snrxk_SynchronizationState_INIT_DOWNLOAD ((snrxk_SynchronizationState)(1))
#define snrxk_SynchronizationState_POST_INIT ((snrxk_SynchronizationState)(2))

/** Possible warning types issued by validation. */
typedef uint8_t snrxk_Warning;
#define snrxk_Warning_UNKNOWN_NEW_RULES_ACTIVATED ((snrxk_Warning)(0))
#define snrxk_Warning_LARGE_WORK_INVALID_CHAIN ((snrxk_Warning)(1))

/** Callback function types */

/**
 * Function signature for the global logging callback. All synorix kernel
 * internal logs will pass through this callback.
 */
typedef void (*snrxk_LogCallback)(void* user_data, const char* message, size_t message_len);

/**
 * Function signature for freeing user data.
 */
typedef void (*snrxk_DestroyCallback)(void* user_data);

/**
 * Function signatures for the kernel notifications.
 */
typedef void (*snrxk_NotifyBlockTip)(void* user_data, snrxk_SynchronizationState state, const snrxk_BlockTreeEntry* entry, double verification_progress);
typedef void (*snrxk_NotifyHeaderTip)(void* user_data, snrxk_SynchronizationState state, int64_t height, int64_t timestamp, int presync);
typedef void (*snrxk_NotifyProgress)(void* user_data, const char* title, size_t title_len, int progress_percent, int resume_possible);
typedef void (*snrxk_NotifyWarningSet)(void* user_data, snrxk_Warning warning, const char* message, size_t message_len);
typedef void (*snrxk_NotifyWarningUnset)(void* user_data, snrxk_Warning warning);
typedef void (*snrxk_NotifyFlushError)(void* user_data, const char* message, size_t message_len);
typedef void (*snrxk_NotifyFatalError)(void* user_data, const char* message, size_t message_len);

/**
 * Function signatures for the validation interface.
 */
typedef void (*snrxk_ValidationInterfaceBlockChecked)(void* user_data, snrxk_Block* block, const snrxk_BlockValidationState* state);
typedef void (*snrxk_ValidationInterfacePoWValidBlock)(void* user_data, snrxk_Block* block, const snrxk_BlockTreeEntry* entry);
typedef void (*snrxk_ValidationInterfaceBlockConnected)(void* user_data, snrxk_Block* block, const snrxk_BlockTreeEntry* entry);
typedef void (*snrxk_ValidationInterfaceBlockDisconnected)(void* user_data, snrxk_Block* block, const snrxk_BlockTreeEntry* entry);

/**
 * Function signature for serializing data.
 *
 * Returns 0 to indicate success.
 */
typedef int (*snrxk_WriteBytes)(const void* bytes, size_t size, void* userdata);

/**
 * Whether a validated data structure is valid, invalid, or an error was
 * encountered during processing.
 */
typedef uint8_t snrxk_ValidationMode;
#define snrxk_ValidationMode_VALID ((snrxk_ValidationMode)(0))
#define snrxk_ValidationMode_INVALID ((snrxk_ValidationMode)(1))
#define snrxk_ValidationMode_INTERNAL_ERROR ((snrxk_ValidationMode)(2))

/**
 * A granular "reason" why a block was invalid.
 */
typedef uint32_t snrxk_BlockValidationResult;
#define snrxk_BlockValidationResult_UNSET ((snrxk_BlockValidationResult)(0))           //!< initial value. Block has not yet been rejected
#define snrxk_BlockValidationResult_CONSENSUS ((snrxk_BlockValidationResult)(1))       //!< invalid by consensus rules (excluding any below reasons)
#define snrxk_BlockValidationResult_CACHED_INVALID ((snrxk_BlockValidationResult)(2))  //!< this block was cached as being invalid and we didn't store the reason why
#define snrxk_BlockValidationResult_INVALID_HEADER ((snrxk_BlockValidationResult)(3))  //!< invalid proof of work or time too old
#define snrxk_BlockValidationResult_MUTATED ((snrxk_BlockValidationResult)(4))         //!< the block's data didn't match the data committed to by the PoW
#define snrxk_BlockValidationResult_MISSING_PREV ((snrxk_BlockValidationResult)(5))    //!< We don't have the previous block the checked one is built on
#define snrxk_BlockValidationResult_INVALID_PREV ((snrxk_BlockValidationResult)(6))    //!< A block this one builds on is invalid
#define snrxk_BlockValidationResult_TIME_FUTURE ((snrxk_BlockValidationResult)(7))     //!< block timestamp was > 2 hours in the future (or our clock is bad)
#define snrxk_BlockValidationResult_HEADER_LOW_WORK ((snrxk_BlockValidationResult)(8)) //!< the block header may be on a too-little-work chain

/**
 * Holds the validation interface callbacks. The user data pointer may be used
 * to point to user-defined structures to make processing the validation
 * callbacks easier. Note that these callbacks block any further validation
 * execution when they are called.
 */
typedef struct {
    void* user_data;                                              //!< Holds a user-defined opaque structure that is passed to the validation
                                                                  //!< interface callbacks. If user_data_destroy is also defined ownership of the
                                                                  //!< user_data is passed to the created context options and subsequently context.
    snrxk_DestroyCallback user_data_destroy;                       //!< Frees the provided user data structure.
    snrxk_ValidationInterfaceBlockChecked block_checked;           //!< Called when a new block has been fully validated. Contains the
                                                                  //!< result of its validation.
    snrxk_ValidationInterfacePoWValidBlock pow_valid_block;        //!< Called when a new block extends the header chain and has a valid transaction
                                                                  //!< and segwit merkle root.
    snrxk_ValidationInterfaceBlockConnected block_connected;       //!< Called when a block is valid and has now been connected to the best chain.
    snrxk_ValidationInterfaceBlockDisconnected block_disconnected; //!< Called during a re-org when a block has been removed from the best chain.
} snrxk_ValidationInterfaceCallbacks;

/**
 * A struct for holding the kernel notification callbacks. The user data
 * pointer may be used to point to user-defined structures to make processing
 * the notifications easier.
 *
 * If user_data_destroy is provided, the kernel will automatically call this
 * callback to clean up user_data when the notification interface object is destroyed.
 * If user_data_destroy is NULL, it is the user's responsibility to ensure that
 * the user_data outlives the kernel objects. Notifications can
 * occur even as kernel objects are deleted, so care has to be taken to ensure
 * safe unwinding.
 */
typedef struct {
    void* user_data;                        //!< Holds a user-defined opaque structure that is passed to the notification callbacks.
                                            //!< If user_data_destroy is also defined ownership of the user_data is passed to the
                                            //!< created context options and subsequently context.
    snrxk_DestroyCallback user_data_destroy; //!< Frees the provided user data structure.
    snrxk_NotifyBlockTip block_tip;          //!< The chain's tip was updated to the provided block entry.
    snrxk_NotifyHeaderTip header_tip;        //!< A new best block header was added.
    snrxk_NotifyProgress progress;           //!< Reports on current block synchronization progress.
    snrxk_NotifyWarningSet warning_set;      //!< A warning issued by the kernel library during validation.
    snrxk_NotifyWarningUnset warning_unset;  //!< A previous condition leading to the issuance of a warning is no longer given.
    snrxk_NotifyFlushError flush_error;      //!< An error encountered when flushing data to disk.
    snrxk_NotifyFatalError fatal_error;      //!< An unrecoverable system error encountered by the library.
} snrxk_NotificationInterfaceCallbacks;

/**
 * A collection of logging categories that may be encountered by kernel code.
 */
typedef uint8_t snrxk_LogCategory;
#define snrxk_LogCategory_ALL ((snrxk_LogCategory)(0))
#define snrxk_LogCategory_BENCH ((snrxk_LogCategory)(1))
#define snrxk_LogCategory_BLOCKSTORAGE ((snrxk_LogCategory)(2))
#define snrxk_LogCategory_COINDB ((snrxk_LogCategory)(3))
#define snrxk_LogCategory_LEVELDB ((snrxk_LogCategory)(4))
#define snrxk_LogCategory_MEMPOOL ((snrxk_LogCategory)(5))
#define snrxk_LogCategory_PRUNE ((snrxk_LogCategory)(6))
#define snrxk_LogCategory_RAND ((snrxk_LogCategory)(7))
#define snrxk_LogCategory_REINDEX ((snrxk_LogCategory)(8))
#define snrxk_LogCategory_VALIDATION ((snrxk_LogCategory)(9))
#define snrxk_LogCategory_KERNEL ((snrxk_LogCategory)(10))

/**
 * The level at which logs should be produced.
 */
typedef uint8_t snrxk_LogLevel;
#define snrxk_LogLevel_TRACE ((snrxk_LogLevel)(0))
#define snrxk_LogLevel_DEBUG ((snrxk_LogLevel)(1))
#define snrxk_LogLevel_INFO ((snrxk_LogLevel)(2))

/**
 * Options controlling the format of log messages.
 *
 * Set fields as non-zero to indicate true.
 */
typedef struct {
    int log_timestamps;               //!< Prepend a timestamp to log messages.
    int log_time_micros;              //!< Log timestamps in microsecond precision.
    int log_threadnames;              //!< Prepend the name of the thread to log messages.
    int log_sourcelocations;          //!< Prepend the source location to log messages.
    int always_print_category_levels; //!< Prepend the log category and level to log messages.
} snrxk_LoggingOptions;

/**
 * A collection of status codes that may be issued by the script verify function.
 */
typedef uint8_t snrxk_ScriptVerifyStatus;
#define snrxk_ScriptVerifyStatus_OK ((snrxk_ScriptVerifyStatus)(0))
#define snrxk_ScriptVerifyStatus_ERROR_INVALID_FLAGS_COMBINATION ((snrxk_ScriptVerifyStatus)(1)) //!< The flags were combined in an invalid way.
#define snrxk_ScriptVerifyStatus_ERROR_SPENT_OUTPUTS_REQUIRED ((snrxk_ScriptVerifyStatus)(2))    //!< The taproot flag was set, so valid spent_outputs have to be provided.

/**
 * Script verification flags that may be composed with each other.
 */
typedef uint32_t snrxk_ScriptVerificationFlags;
#define snrxk_ScriptVerificationFlags_NONE ((snrxk_ScriptVerificationFlags)(0))
#define snrxk_ScriptVerificationFlags_P2SH ((snrxk_ScriptVerificationFlags)(1U << 0))                 //!< evaluate P2SH (BIP16) subscripts
#define snrxk_ScriptVerificationFlags_DERSIG ((snrxk_ScriptVerificationFlags)(1U << 2))               //!< enforce strict DER (BIP66) compliance
#define snrxk_ScriptVerificationFlags_NULLDUMMY ((snrxk_ScriptVerificationFlags)(1U << 4))            //!< enforce NULLDUMMY (BIP147)
#define snrxk_ScriptVerificationFlags_CHECKLOCKTIMEVERIFY ((snrxk_ScriptVerificationFlags)(1U << 9))  //!< enable CHECKLOCKTIMEVERIFY (BIP65)
#define snrxk_ScriptVerificationFlags_CHECKSEQUENCEVERIFY ((snrxk_ScriptVerificationFlags)(1U << 10)) //!< enable CHECKSEQUENCEVERIFY (BIP112)
#define snrxk_ScriptVerificationFlags_WITNESS ((snrxk_ScriptVerificationFlags)(1U << 11))             //!< enable WITNESS (BIP141)
#define snrxk_ScriptVerificationFlags_TAPROOT ((snrxk_ScriptVerificationFlags)(1U << 17))             //!< enable TAPROOT (BIPs 341 & 342)
#define snrxk_ScriptVerificationFlags_ALL ((snrxk_ScriptVerificationFlags)(snrxk_ScriptVerificationFlags_P2SH |                \
                                                                         snrxk_ScriptVerificationFlags_DERSIG |              \
                                                                         snrxk_ScriptVerificationFlags_NULLDUMMY |           \
                                                                         snrxk_ScriptVerificationFlags_CHECKLOCKTIMEVERIFY | \
                                                                         snrxk_ScriptVerificationFlags_CHECKSEQUENCEVERIFY | \
                                                                         snrxk_ScriptVerificationFlags_WITNESS |             \
                                                                         snrxk_ScriptVerificationFlags_TAPROOT))

typedef uint8_t snrxk_ChainType;
#define snrxk_ChainType_MAINNET ((snrxk_ChainType)(0))
#define snrxk_ChainType_TESTNET ((snrxk_ChainType)(1))
#define snrxk_ChainType_TESTNET_4 ((snrxk_ChainType)(2))
#define snrxk_ChainType_SIGNET ((snrxk_ChainType)(3))
#define snrxk_ChainType_REGTEST ((snrxk_ChainType)(4))

/** @name Transaction
 * Functions for working with transactions.
 */
///@{

/**
 * @brief Create a new transaction from the serialized data.
 *
 * @param[in] raw_transaction     Serialized transaction.
 * @param[in] raw_transaction_len Length of the serialized transaction.
 * @return                        The transaction, or null on error.
 */
BITCOINKERNEL_API snrxk_Transaction* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_transaction_create(
    const void* raw_transaction, size_t raw_transaction_len);

/**
 * @brief Copy a transaction. Transactions are reference counted, so this just
 * increments the reference count.
 *
 * @param[in] transaction Non-null.
 * @return                The copied transaction.
 */
BITCOINKERNEL_API snrxk_Transaction* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_transaction_copy(
    const snrxk_Transaction* transaction) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Serializes the transaction through the passed in callback to bytes.
 * This is consensus serialization that is also used for the P2P network.
 *
 * @param[in] transaction Non-null.
 * @param[in] writer      Non-null, callback to a write bytes function.
 * @param[in] user_data   Holds a user-defined opaque structure that will be
 *                        passed back through the writer callback.
 * @return                0 on success.
 */
BITCOINKERNEL_API int snrxk_transaction_to_bytes(
    const snrxk_Transaction* transaction,
    snrxk_WriteBytes writer,
    void* user_data) BITCOINKERNEL_ARG_NONNULL(1, 2);

/**
 * @brief Get the number of outputs of a transaction.
 *
 * @param[in] transaction Non-null.
 * @return                The number of outputs.
 */
BITCOINKERNEL_API size_t BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_transaction_count_outputs(
    const snrxk_Transaction* transaction) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Get the transaction outputs at the provided index. The returned
 * transaction output is not owned and depends on the lifetime of the
 * transaction.
 *
 * @param[in] transaction  Non-null.
 * @param[in] output_index The index of the transaction output to be retrieved.
 * @return                 The transaction output
 */
BITCOINKERNEL_API const snrxk_TransactionOutput* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_transaction_get_output_at(
    const snrxk_Transaction* transaction, size_t output_index) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Get the transaction input at the provided index. The returned
 * transaction input is not owned and depends on the lifetime of the
 * transaction.
 *
 * @param[in] transaction Non-null.
 * @param[in] input_index The index of the transaction input to be retrieved.
 * @return                 The transaction input
 */
BITCOINKERNEL_API const snrxk_TransactionInput* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_transaction_get_input_at(
    const snrxk_Transaction* transaction, size_t input_index) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Get the number of inputs of a transaction.
 *
 * @param[in] transaction Non-null.
 * @return                The number of inputs.
 */
BITCOINKERNEL_API size_t BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_transaction_count_inputs(
    const snrxk_Transaction* transaction) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Get a transaction's nLockTime value.
 *
 * @param[in] transaction Non-null.
 * @return                The nLockTime value.
 */
BITCOINKERNEL_API uint32_t BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_transaction_get_locktime(
    const snrxk_Transaction* transaction) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Get the txid of a transaction. The returned txid is not owned and
 * depends on the lifetime of the transaction.
 *
 * @param[in] transaction Non-null.
 * @return                The txid.
 */
BITCOINKERNEL_API const snrxk_Txid* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_transaction_get_txid(
    const snrxk_Transaction* transaction) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * Destroy the transaction.
 */
BITCOINKERNEL_API void snrxk_transaction_destroy(snrxk_Transaction* transaction);

///@}

/** @name PrecomputedTransactionData
 * Functions for working with precomputed transaction data.
 */
///@{

/**
 * @brief Create precomputed transaction data for script verification.
 *
 * @param[in] tx_to             Non-null.
 * @param[in] spent_outputs     Nullable for non-taproot verification. Points to an array of
 *                              outputs spent by the transaction.
 * @param[in] spent_outputs_len Length of the spent_outputs array.
 * @return                      The precomputed data, or null on error.
 */
BITCOINKERNEL_API snrxk_PrecomputedTransactionData* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_precomputed_transaction_data_create(
    const snrxk_Transaction* tx_to,
    const snrxk_TransactionOutput** spent_outputs, size_t spent_outputs_len) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Copy precomputed transaction data.
 *
 * @param[in] precomputed_txdata Non-null.
 * @return                       The copied precomputed transaction data.
 */
BITCOINKERNEL_API snrxk_PrecomputedTransactionData* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_precomputed_transaction_data_copy(
    const snrxk_PrecomputedTransactionData* precomputed_txdata) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * Destroy the precomputed transaction data.
 */
BITCOINKERNEL_API void snrxk_precomputed_transaction_data_destroy(snrxk_PrecomputedTransactionData* precomputed_txdata);

///@}

/** @name ScriptPubkey
 * Functions for working with script pubkeys.
 */
///@{

/**
 * @brief Create a script pubkey from serialized data.
 * @param[in] script_pubkey     Serialized script pubkey.
 * @param[in] script_pubkey_len Length of the script pubkey data.
 * @return                      The script pubkey.
 */
BITCOINKERNEL_API snrxk_ScriptPubkey* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_script_pubkey_create(
    const void* script_pubkey, size_t script_pubkey_len);

/**
 * @brief Copy a script pubkey.
 *
 * @param[in] script_pubkey Non-null.
 * @return                  The copied script pubkey.
 */
BITCOINKERNEL_API snrxk_ScriptPubkey* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_script_pubkey_copy(
    const snrxk_ScriptPubkey* script_pubkey) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Verify if the input at input_index of tx_to spends the script pubkey
 * under the constraints specified by flags. If the
 * `snrxk_ScriptVerificationFlags_WITNESS` flag is set in the flags bitfield, the
 * amount parameter is used. If the taproot flag is set, the precomputed data
 * must contain the spent outputs.
 *
 * @param[in] script_pubkey      Non-null, script pubkey to be spent.
 * @param[in] amount             Amount of the script pubkey's associated output. May be zero if
 *                               the witness flag is not set.
 * @param[in] tx_to              Non-null, transaction spending the script_pubkey.
 * @param[in] precomputed_txdata Nullable if the taproot flag is not set. Otherwise, precomputed data
 *                               for tx_to with the spent outputs must be provided.
 * @param[in] input_index        Index of the input in tx_to spending the script_pubkey.
 * @param[in] flags              Bitfield of snrxk_ScriptVerificationFlags controlling validation constraints.
 * @param[out] status            Nullable, will be set to an error code if the operation fails, or OK otherwise.
 * @return                       1 if the script is valid, 0 otherwise.
 */
BITCOINKERNEL_API int BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_script_pubkey_verify(
    const snrxk_ScriptPubkey* script_pubkey,
    int64_t amount,
    const snrxk_Transaction* tx_to,
    const snrxk_PrecomputedTransactionData* precomputed_txdata,
    unsigned int input_index,
    snrxk_ScriptVerificationFlags flags,
    snrxk_ScriptVerifyStatus* status) BITCOINKERNEL_ARG_NONNULL(1, 3);

/**
 * @brief Serializes the script pubkey through the passed in callback to bytes.
 *
 * @param[in] script_pubkey Non-null.
 * @param[in] writer        Non-null, callback to a write bytes function.
 * @param[in] user_data     Holds a user-defined opaque structure that will be
 *                          passed back through the writer callback.
 * @return                  0 on success.
 */
BITCOINKERNEL_API int snrxk_script_pubkey_to_bytes(
    const snrxk_ScriptPubkey* script_pubkey,
    snrxk_WriteBytes writer,
    void* user_data) BITCOINKERNEL_ARG_NONNULL(1, 2);

/**
 * Destroy the script pubkey.
 */
BITCOINKERNEL_API void snrxk_script_pubkey_destroy(snrxk_ScriptPubkey* script_pubkey);

///@}

/** @name TransactionOutput
 * Functions for working with transaction outputs.
 */
///@{

/**
 * @brief Create a transaction output from a script pubkey and an amount.
 *
 * @param[in] script_pubkey Non-null.
 * @param[in] amount        The amount associated with the script pubkey for this output.
 * @return                  The transaction output.
 */
BITCOINKERNEL_API snrxk_TransactionOutput* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_transaction_output_create(
    const snrxk_ScriptPubkey* script_pubkey,
    int64_t amount) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Get the script pubkey of the output. The returned
 * script pubkey is not owned and depends on the lifetime of the
 * transaction output.
 *
 * @param[in] transaction_output Non-null.
 * @return                       The script pubkey.
 */
BITCOINKERNEL_API const snrxk_ScriptPubkey* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_transaction_output_get_script_pubkey(
    const snrxk_TransactionOutput* transaction_output) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Get the amount in the output.
 *
 * @param[in] transaction_output Non-null.
 * @return                       The amount.
 */
BITCOINKERNEL_API int64_t BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_transaction_output_get_amount(
    const snrxk_TransactionOutput* transaction_output) BITCOINKERNEL_ARG_NONNULL(1);

/**
 *  @brief Copy a transaction output.
 *
 *  @param[in] transaction_output Non-null.
 *  @return                       The copied transaction output.
 */
BITCOINKERNEL_API snrxk_TransactionOutput* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_transaction_output_copy(
    const snrxk_TransactionOutput* transaction_output) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * Destroy the transaction output.
 */
BITCOINKERNEL_API void snrxk_transaction_output_destroy(snrxk_TransactionOutput* transaction_output);

///@}

/** @name Logging
 * Logging-related functions.
 */
///@{

/**
 * @brief This disables the global internal logger. No log messages will be
 * buffered internally anymore once this is called and the buffer is cleared.
 * This function should only be called once and is not thread or re-entry safe.
 * Log messages will be buffered until this function is called, or a logging
 * connection is created. This must not be called while a logging connection
 * already exists.
 */
BITCOINKERNEL_API void snrxk_logging_disable();

/**
 * @brief Set some options for the global internal logger. This changes global
 * settings and will override settings for all existing @ref
 * snrxk_LoggingConnection instances.
 *
 * @param[in] options Sets formatting options of the log messages.
 */
BITCOINKERNEL_API void snrxk_logging_set_options(snrxk_LoggingOptions options);

/**
 * @brief Set the log level of the global internal logger. This does not
 * enable the selected categories. Use @ref snrxk_logging_enable_category to
 * start logging from a specific, or all categories. This changes a global
 * setting and will override settings for all existing
 * @ref snrxk_LoggingConnection instances.
 *
 * @param[in] category If snrxk_LogCategory_ALL is chosen, sets both the global fallback log level
 *                     used by all categories that don't have a specific level set, and also
 *                     sets the log level for messages logged with the snrxk_LogCategory_ALL category itself.
 *                     For any other category, sets a category-specific log level that overrides
 *                     the global fallback for that category only.

 * @param[in] level    Log level at which the log category is set.
 */
BITCOINKERNEL_API void snrxk_logging_set_level_category(snrxk_LogCategory category, snrxk_LogLevel level);

/**
 * @brief Enable a specific log category for the global internal logger. This
 * changes a global setting and will override settings for all existing @ref
 * snrxk_LoggingConnection instances.
 *
 * @param[in] category If snrxk_LogCategory_ALL is chosen, all categories will be enabled.
 */
BITCOINKERNEL_API void snrxk_logging_enable_category(snrxk_LogCategory category);

/**
 * @brief Disable a specific log category for the global internal logger. This
 * changes a global setting and will override settings for all existing @ref
 * snrxk_LoggingConnection instances.
 *
 * @param[in] category If snrxk_LogCategory_ALL is chosen, all categories will be disabled.
 */
BITCOINKERNEL_API void snrxk_logging_disable_category(snrxk_LogCategory category);

/**
 * @brief Start logging messages through the provided callback. Log messages
 * produced before this function is first called are buffered and on calling this
 * function are logged immediately.
 *
 * @param[in] log_callback               Non-null, function through which messages will be logged.
 * @param[in] user_data                  Nullable, holds a user-defined opaque structure. Is passed back
 *                                       to the user through the callback. If the user_data_destroy_callback
 *                                       is also defined it is assumed that ownership of the user_data is passed
 *                                       to the created logging connection.
 * @param[in] user_data_destroy_callback Nullable, function for freeing the user data.
 * @return                               A new kernel logging connection, or null on error.
 */
BITCOINKERNEL_API snrxk_LoggingConnection* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_logging_connection_create(
    snrxk_LogCallback log_callback,
    void* user_data,
    snrxk_DestroyCallback user_data_destroy_callback) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * Stop logging and destroy the logging connection.
 */
BITCOINKERNEL_API void snrxk_logging_connection_destroy(snrxk_LoggingConnection* logging_connection);

///@}

/** @name ChainParameters
 * Functions for working with chain parameters.
 */
///@{

/**
 * @brief Creates a chain parameters struct with default parameters based on the
 * passed in chain type.
 *
 * @param[in] chain_type Controls the chain parameters type created.
 * @return               An allocated chain parameters opaque struct.
 */
BITCOINKERNEL_API snrxk_ChainParameters* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_chain_parameters_create(
    snrxk_ChainType chain_type);

/**
 * Copy the chain parameters.
 */
BITCOINKERNEL_API snrxk_ChainParameters* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_chain_parameters_copy(
    const snrxk_ChainParameters* chain_parameters) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * Destroy the chain parameters.
 */
BITCOINKERNEL_API void snrxk_chain_parameters_destroy(snrxk_ChainParameters* chain_parameters);

///@}

/** @name ContextOptions
 * Functions for working with context options.
 */
///@{

/**
 * Creates an empty context options.
 */
BITCOINKERNEL_API snrxk_ContextOptions* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_context_options_create();

/**
 * @brief Sets the chain params for the context options. The context created
 * with the options will be configured for these chain parameters.
 *
 * @param[in] context_options  Non-null, previously created by @ref snrxk_context_options_create.
 * @param[in] chain_parameters Is set to the context options.
 */
BITCOINKERNEL_API void snrxk_context_options_set_chainparams(
    snrxk_ContextOptions* context_options,
    const snrxk_ChainParameters* chain_parameters) BITCOINKERNEL_ARG_NONNULL(1, 2);

/**
 * @brief Set the kernel notifications for the context options. The context
 * created with the options will be configured with these notifications.
 *
 * @param[in] context_options Non-null, previously created by @ref snrxk_context_options_create.
 * @param[in] notifications   Is set to the context options.
 */
BITCOINKERNEL_API void snrxk_context_options_set_notifications(
    snrxk_ContextOptions* context_options,
    snrxk_NotificationInterfaceCallbacks notifications) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Set the validation interface callbacks for the context options. The
 * context created with the options will be configured for these validation
 * interface callbacks. The callbacks will then be triggered from validation
 * events issued by the chainstate manager created from the same context.
 *
 * @param[in] context_options                Non-null, previously created with snrxk_context_options_create.
 * @param[in] validation_interface_callbacks The callbacks used for passing validation information to the
 *                                           user.
 */
BITCOINKERNEL_API void snrxk_context_options_set_validation_interface(
    snrxk_ContextOptions* context_options,
    snrxk_ValidationInterfaceCallbacks validation_interface_callbacks) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * Destroy the context options.
 */
BITCOINKERNEL_API void snrxk_context_options_destroy(snrxk_ContextOptions* context_options);

///@}

/** @name Context
 * Functions for working with contexts.
 */
///@{

/**
 * @brief Create a new kernel context. If the options have not been previously
 * set, their corresponding fields will be initialized to default values; the
 * context will assume mainnet chain parameters and won't attempt to call the
 * kernel notification callbacks.
 *
 * @param[in] context_options Nullable, created by @ref snrxk_context_options_create.
 * @return                    The allocated context, or null on error.
 */
BITCOINKERNEL_API snrxk_Context* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_context_create(
    const snrxk_ContextOptions* context_options);

/**
 * Copy the context.
 */
BITCOINKERNEL_API snrxk_Context* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_context_copy(
    const snrxk_Context* context) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Interrupt can be used to halt long-running validation functions like
 * when reindexing, importing or processing blocks.
 *
 * @param[in] context  Non-null.
 * @return             0 if the interrupt was successful, non-zero otherwise.
 */
BITCOINKERNEL_API int BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_context_interrupt(
    snrxk_Context* context) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * Destroy the context.
 */
BITCOINKERNEL_API void snrxk_context_destroy(snrxk_Context* context);

///@}

/** @name BlockTreeEntry
 * Functions for working with block tree entries.
 */
///@{

/**
 * @brief Returns the previous block tree entry in the tree, or null if the current
 * block tree entry is the genesis block.
 *
 * @param[in] block_tree_entry Non-null.
 * @return                     The previous block tree entry, or null on error or if the current block tree entry is the genesis block.
 */
BITCOINKERNEL_API const snrxk_BlockTreeEntry* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_tree_entry_get_previous(
    const snrxk_BlockTreeEntry* block_tree_entry) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Return the snrxk_BlockHeader associated with this entry.
 *
 * @param[in] block_tree_entry Non-null.
 * @return                     snrxk_BlockHeader.
 */
BITCOINKERNEL_API snrxk_BlockHeader* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_tree_entry_get_block_header(
    const snrxk_BlockTreeEntry* block_tree_entry) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Return the height of a certain block tree entry.
 *
 * @param[in] block_tree_entry Non-null.
 * @return                     The block height.
 */
BITCOINKERNEL_API int32_t BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_tree_entry_get_height(
    const snrxk_BlockTreeEntry* block_tree_entry) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Return the block hash associated with a block tree entry.
 *
 * @param[in] block_tree_entry Non-null.
 * @return                     The block hash.
 */
BITCOINKERNEL_API const snrxk_BlockHash* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_tree_entry_get_block_hash(
    const snrxk_BlockTreeEntry* block_tree_entry) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Check if two block tree entries are equal. Two block tree entries are equal when they
 * point to the same block.
 *
 * @param[in] entry1 Non-null.
 * @param[in] entry2 Non-null.
 * @return           1 if the block tree entries are equal, 0 otherwise.
 */
BITCOINKERNEL_API int BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_tree_entry_equals(
    const snrxk_BlockTreeEntry* entry1, const snrxk_BlockTreeEntry* entry2) BITCOINKERNEL_ARG_NONNULL(1, 2);

///@}

/** @name ChainstateManagerOptions
 * Functions for working with chainstate manager options.
 */
///@{

/**
 * @brief Create options for the chainstate manager.
 *
 * @param[in] context          Non-null, the created options and through it the chainstate manager will
 *                             associate with this kernel context for the duration of their lifetimes.
 * @param[in] data_directory   Non-null, non-empty path string of the directory containing the
 *                             chainstate data. If the directory does not exist yet, it will be
 *                             created.
 * @param[in] blocks_directory Non-null, non-empty path string of the directory containing the block
 *                             data. If the directory does not exist yet, it will be created.
 * @return                     The allocated chainstate manager options, or null on error.
 */
BITCOINKERNEL_API snrxk_ChainstateManagerOptions* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_chainstate_manager_options_create(
    const snrxk_Context* context,
    const char* data_directory,
    size_t data_directory_len,
    const char* blocks_directory,
    size_t blocks_directory_len) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Set the number of available worker threads used during validation.
 *
 * @param[in] chainstate_manager_options Non-null, options to be set.
 * @param[in] worker_threads             The number of worker threads that should be spawned in the thread pool
 *                                       used for validation. When set to 0 no parallel verification is done.
 *                                       The value range is clamped internally between 0 and 15.
 */
BITCOINKERNEL_API void snrxk_chainstate_manager_options_set_worker_threads_num(
    snrxk_ChainstateManagerOptions* chainstate_manager_options,
    int worker_threads) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Sets wipe db in the options. In combination with calling
 * @ref snrxk_chainstate_manager_import_blocks this triggers either a full reindex,
 * or a reindex of just the chainstate database.
 *
 * @param[in] chainstate_manager_options Non-null, created by @ref snrxk_chainstate_manager_options_create.
 * @param[in] wipe_block_tree_db         Set wipe block tree db. Should only be 1 if wipe_chainstate_db is 1 too.
 * @param[in] wipe_chainstate_db         Set wipe chainstate db.
 * @return                               0 if the set was successful, non-zero if the set failed.
 */
BITCOINKERNEL_API int BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_chainstate_manager_options_set_wipe_dbs(
    snrxk_ChainstateManagerOptions* chainstate_manager_options,
    int wipe_block_tree_db,
    int wipe_chainstate_db) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Sets block tree db in memory in the options.
 *
 * @param[in] chainstate_manager_options   Non-null, created by @ref snrxk_chainstate_manager_options_create.
 * @param[in] block_tree_db_in_memory      Set block tree db in memory.
 */
BITCOINKERNEL_API void snrxk_chainstate_manager_options_update_block_tree_db_in_memory(
    snrxk_ChainstateManagerOptions* chainstate_manager_options,
    int block_tree_db_in_memory) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Sets chainstate db in memory in the options.
 *
 * @param[in] chainstate_manager_options Non-null, created by @ref snrxk_chainstate_manager_options_create.
 * @param[in] chainstate_db_in_memory    Set chainstate db in memory.
 */
BITCOINKERNEL_API void snrxk_chainstate_manager_options_update_chainstate_db_in_memory(
    snrxk_ChainstateManagerOptions* chainstate_manager_options,
    int chainstate_db_in_memory) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * Destroy the chainstate manager options.
 */
BITCOINKERNEL_API void snrxk_chainstate_manager_options_destroy(snrxk_ChainstateManagerOptions* chainstate_manager_options);

///@}

/** @name ChainstateManager
 * Functions for chainstate management.
 */
///@{

/**
 * @brief Create a chainstate manager. This is the main object for many
 * validation tasks as well as for retrieving data from the chain and
 * interacting with its chainstate and indexes.
 *
 * @param[in] chainstate_manager_options Non-null, created by @ref snrxk_chainstate_manager_options_create.
 * @return                               The allocated chainstate manager, or null on error.
 */
BITCOINKERNEL_API snrxk_ChainstateManager* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_chainstate_manager_create(
    const snrxk_ChainstateManagerOptions* chainstate_manager_options) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Get the snrxk_BlockTreeEntry whose associated snrxk_BlockHeader has the most
 * known cumulative proof of work.
 *
 * @param[in] chainstate_manager Non-null.
 * @return                       The snrxk_BlockTreeEntry.
 */
BITCOINKERNEL_API const snrxk_BlockTreeEntry* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_chainstate_manager_get_best_entry(
    const snrxk_ChainstateManager* chainstate_manager) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Processes and validates the provided snrxk_BlockHeader.
 *
 * @param[in] chainstate_manager        Non-null.
 * @param[in] header                    Non-null snrxk_BlockHeader to be validated.
 * @param[out] block_validation_state   The result of the snrxk_BlockHeader validation.
 * @return                              0 if snrxk_BlockHeader processing completed successfully, non-zero on error.
 */
BITCOINKERNEL_API int BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_chainstate_manager_process_block_header(
    snrxk_ChainstateManager* chainstate_manager,
    const snrxk_BlockHeader* header,
    snrxk_BlockValidationState* block_validation_state) BITCOINKERNEL_ARG_NONNULL(1, 2, 3);

/**
 * @brief Triggers the start of a reindex if the wipe options were previously
 * set for the chainstate manager. Can also import an array of existing block
 * files selected by the user.
 *
 * @param[in] chainstate_manager        Non-null.
 * @param[in] block_file_paths_data     Nullable, array of block files described by their full filesystem paths.
 * @param[in] block_file_paths_lens     Nullable, array containing the lengths of each of the paths.
 * @param[in] block_file_paths_data_len Length of the block_file_paths_data and block_file_paths_len arrays.
 * @return                              0 if the import blocks call was completed successfully, non-zero otherwise.
 */
BITCOINKERNEL_API int BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_chainstate_manager_import_blocks(
    snrxk_ChainstateManager* chainstate_manager,
    const char** block_file_paths_data, size_t* block_file_paths_lens,
    size_t block_file_paths_data_len) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Process and validate the passed in block with the chainstate
 * manager. Processing first does checks on the block, and if these passed,
 * saves it to disk. It then validates the block against the utxo set. If it is
 * valid, the chain is extended with it. The return value is not indicative of
 * the block's validity. Detailed information on the validity of the block can
 * be retrieved by registering the `block_checked` callback in the validation
 * interface.
 *
 * @param[in] chainstate_manager Non-null.
 * @param[in] block              Non-null, block to be validated.
 *
 * @param[out] new_block         Nullable, will be set to 1 if this block was not processed before. Note that this means it
 *                               might also not be 1 if processing was attempted before, but the block was found invalid
 *                               before its data was persisted.
 * @return                       0 if processing the block was successful. Will also return 0 for valid, but duplicate blocks.
 */
BITCOINKERNEL_API int BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_chainstate_manager_process_block(
    snrxk_ChainstateManager* chainstate_manager,
    const snrxk_Block* block,
    int* new_block) BITCOINKERNEL_ARG_NONNULL(1, 2, 3);

/**
 * @brief Returns the best known currently active chain. Its lifetime is
 * dependent on the chainstate manager. It can be thought of as a view on a
 * vector of block tree entries that form the best chain. The returned chain
 * reference always points to the currently active best chain. However, state
 * transitions within the chainstate manager (e.g., processing blocks) will
 * update the chain's contents. Data retrieved from this chain is only
 * consistent up to the point when new data is processed in the chainstate
 * manager. It is the user's responsibility to guard against these
 * inconsistencies.
 *
 * @param[in] chainstate_manager Non-null.
 * @return                       The chain.
 */
BITCOINKERNEL_API const snrxk_Chain* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_chainstate_manager_get_active_chain(
    const snrxk_ChainstateManager* chainstate_manager) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Retrieve a block tree entry by its block hash.
 *
 * @param[in] chainstate_manager Non-null.
 * @param[in] block_hash         Non-null.
 * @return                       The block tree entry of the block with the passed in hash, or null if
 *                               the block hash is not found.
 */
BITCOINKERNEL_API const snrxk_BlockTreeEntry* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_chainstate_manager_get_block_tree_entry_by_hash(
    const snrxk_ChainstateManager* chainstate_manager,
    const snrxk_BlockHash* block_hash) BITCOINKERNEL_ARG_NONNULL(1, 2);

/**
 * Destroy the chainstate manager.
 */
BITCOINKERNEL_API void snrxk_chainstate_manager_destroy(snrxk_ChainstateManager* chainstate_manager);

///@}

/** @name Block
 * Functions for working with blocks.
 */
///@{

/**
 * @brief Reads the block the passed in block tree entry points to from disk and
 * returns it.
 *
 * @param[in] chainstate_manager Non-null.
 * @param[in] block_tree_entry   Non-null.
 * @return                       The read out block, or null on error.
 */
BITCOINKERNEL_API snrxk_Block* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_read(
    const snrxk_ChainstateManager* chainstate_manager,
    const snrxk_BlockTreeEntry* block_tree_entry) BITCOINKERNEL_ARG_NONNULL(1, 2);

/**
 * @brief Parse a serialized raw block into a new block object.
 *
 * @param[in] raw_block     Serialized block.
 * @param[in] raw_block_len Length of the serialized block.
 * @return                  The allocated block, or null on error.
 */
BITCOINKERNEL_API snrxk_Block* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_create(
    const void* raw_block, size_t raw_block_len);

/**
 * @brief Copy a block. Blocks are reference counted, so this just increments
 * the reference count.
 *
 * @param[in] block Non-null.
 * @return          The copied block.
 */
BITCOINKERNEL_API snrxk_Block* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_copy(
    const snrxk_Block* block) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Count the number of transactions contained in a block.
 *
 * @param[in] block Non-null.
 * @return          The number of transactions in the block.
 */
BITCOINKERNEL_API size_t BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_count_transactions(
    const snrxk_Block* block) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Get the transaction at the provided index. The returned transaction
 * is not owned and depends on the lifetime of the block.
 *
 * @param[in] block             Non-null.
 * @param[in] transaction_index The index of the transaction to be retrieved.
 * @return                      The transaction.
 */
BITCOINKERNEL_API const snrxk_Transaction* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_get_transaction_at(
    const snrxk_Block* block, size_t transaction_index) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Get the snrxk_BlockHeader from the block.
 *
 * Creates a new snrxk_BlockHeader object from the block's header data.
 *
 * @param[in] block Non-null snrxk_Block
 * @return          snrxk_BlockHeader.
 */
BITCOINKERNEL_API snrxk_BlockHeader* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_get_header(
    const snrxk_Block* block) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Calculate and return the hash of a block.
 *
 * @param[in] block Non-null.
 * @return    The block hash.
 */
BITCOINKERNEL_API snrxk_BlockHash* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_get_hash(
    const snrxk_Block* block) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Serializes the block through the passed in callback to bytes.
 * This is consensus serialization that is also used for the P2P network.
 *
 * @param[in] block     Non-null.
 * @param[in] writer    Non-null, callback to a write bytes function.
 * @param[in] user_data Holds a user-defined opaque structure that will be
 *                      passed back through the writer callback.
 * @return              0 on success.
 */
BITCOINKERNEL_API int snrxk_block_to_bytes(
    const snrxk_Block* block,
    snrxk_WriteBytes writer,
    void* user_data) BITCOINKERNEL_ARG_NONNULL(1, 2);

/**
 * Destroy the block.
 */
BITCOINKERNEL_API void snrxk_block_destroy(snrxk_Block* block);

///@}

/** @name BlockValidationState
 * Functions for working with block validation states.
 */
///@{

/**
 * Create a new snrxk_BlockValidationState.
 */
BITCOINKERNEL_API snrxk_BlockValidationState* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_validation_state_create();

/**
 * Returns the validation mode from an opaque snrxk_BlockValidationState pointer.
 */
BITCOINKERNEL_API snrxk_ValidationMode snrxk_block_validation_state_get_validation_mode(
    const snrxk_BlockValidationState* block_validation_state) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * Returns the validation result from an opaque snrxk_BlockValidationState pointer.
 */
BITCOINKERNEL_API snrxk_BlockValidationResult snrxk_block_validation_state_get_block_validation_result(
    const snrxk_BlockValidationState* block_validation_state) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Copies the snrxk_BlockValidationState.
 *
 * @param[in] block_validation_state Non-null.
 * @return                           The copied snrxk_BlockValidationState.
 */
BITCOINKERNEL_API snrxk_BlockValidationState* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_validation_state_copy(
    const snrxk_BlockValidationState* block_validation_state) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * Destroy the snrxk_BlockValidationState.
 */
BITCOINKERNEL_API void snrxk_block_validation_state_destroy(
    snrxk_BlockValidationState* block_validation_state);

///@}

/** @name Chain
 * Functions for working with the chain
 */
///@{

/**
 * @brief Return the height of the tip of the chain.
 *
 * @param[in] chain Non-null.
 * @return          The current height.
 */
BITCOINKERNEL_API int32_t BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_chain_get_height(
    const snrxk_Chain* chain) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Retrieve a block tree entry by its height in the currently active chain.
 * Once retrieved there is no guarantee that it remains in the active chain.
 *
 * @param[in] chain        Non-null.
 * @param[in] block_height Height in the chain of the to be retrieved block tree entry.
 * @return                 The block tree entry at a certain height in the currently active chain, or null
 *                         if the height is out of bounds.
 */
BITCOINKERNEL_API const snrxk_BlockTreeEntry* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_chain_get_by_height(
    const snrxk_Chain* chain,
    int block_height) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Return true if the passed in chain contains the block tree entry.
 *
 * @param[in] chain            Non-null.
 * @param[in] block_tree_entry Non-null.
 * @return                     1 if the block_tree_entry is in the chain, 0 otherwise.
 *
 */
BITCOINKERNEL_API int BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_chain_contains(
    const snrxk_Chain* chain,
    const snrxk_BlockTreeEntry* block_tree_entry) BITCOINKERNEL_ARG_NONNULL(1, 2);

///@}

/** @name BlockSpentOutputs
 * Functions for working with block spent outputs.
 */
///@{

/**
 * @brief Reads the block spent coins data the passed in block tree entry points to from
 * disk and returns it.
 *
 * @param[in] chainstate_manager Non-null.
 * @param[in] block_tree_entry   Non-null.
 * @return                       The read out block spent outputs, or null on error.
 */
BITCOINKERNEL_API snrxk_BlockSpentOutputs* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_spent_outputs_read(
    const snrxk_ChainstateManager* chainstate_manager,
    const snrxk_BlockTreeEntry* block_tree_entry) BITCOINKERNEL_ARG_NONNULL(1, 2);

/**
 * @brief Copy a block's spent outputs.
 *
 * @param[in] block_spent_outputs Non-null.
 * @return                        The copied block spent outputs.
 */
BITCOINKERNEL_API snrxk_BlockSpentOutputs* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_spent_outputs_copy(
    const snrxk_BlockSpentOutputs* block_spent_outputs) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Returns the number of transaction spent outputs whose data is contained in
 * block spent outputs.
 *
 * @param[in] block_spent_outputs Non-null.
 * @return                        The number of transaction spent outputs data in the block spent outputs.
 */
BITCOINKERNEL_API size_t BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_spent_outputs_count(
    const snrxk_BlockSpentOutputs* block_spent_outputs) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Returns a transaction spent outputs contained in the block spent
 * outputs at a certain index. The returned pointer is unowned and only valid
 * for the lifetime of block_spent_outputs.
 *
 * @param[in] block_spent_outputs             Non-null.
 * @param[in] transaction_spent_outputs_index The index of the transaction spent outputs within the block spent outputs.
 * @return                                    A transaction spent outputs pointer.
 */
BITCOINKERNEL_API const snrxk_TransactionSpentOutputs* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_spent_outputs_get_transaction_spent_outputs_at(
    const snrxk_BlockSpentOutputs* block_spent_outputs,
    size_t transaction_spent_outputs_index) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * Destroy the block spent outputs.
 */
BITCOINKERNEL_API void snrxk_block_spent_outputs_destroy(snrxk_BlockSpentOutputs* block_spent_outputs);

///@}

/** @name TransactionSpentOutputs
 * Functions for working with the spent coins of a transaction
 */
///@{

/**
 * @brief Copy a transaction's spent outputs.
 *
 * @param[in] transaction_spent_outputs Non-null.
 * @return                              The copied transaction spent outputs.
 */
BITCOINKERNEL_API snrxk_TransactionSpentOutputs* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_transaction_spent_outputs_copy(
    const snrxk_TransactionSpentOutputs* transaction_spent_outputs) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Returns the number of previous transaction outputs contained in the
 * transaction spent outputs data.
 *
 * @param[in] transaction_spent_outputs Non-null
 * @return                              The number of spent transaction outputs for the transaction.
 */
BITCOINKERNEL_API size_t BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_transaction_spent_outputs_count(
    const snrxk_TransactionSpentOutputs* transaction_spent_outputs) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Returns a coin contained in the transaction spent outputs at a
 * certain index. The returned pointer is unowned and only valid for the
 * lifetime of transaction_spent_outputs.
 *
 * @param[in] transaction_spent_outputs Non-null.
 * @param[in] coin_index                The index of the to be retrieved coin within the
 *                                      transaction spent outputs.
 * @return                              A coin pointer.
 */
BITCOINKERNEL_API const snrxk_Coin* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_transaction_spent_outputs_get_coin_at(
    const snrxk_TransactionSpentOutputs* transaction_spent_outputs,
    size_t coin_index) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * Destroy the transaction spent outputs.
 */
BITCOINKERNEL_API void snrxk_transaction_spent_outputs_destroy(snrxk_TransactionSpentOutputs* transaction_spent_outputs);

///@}

/** @name Transaction Input
 * Functions for working with transaction inputs.
 */
///@{

/**
 * @brief Copy a transaction input.
 *
 * @param[in] transaction_input Non-null.
 * @return                      The copied transaction input.
 */
BITCOINKERNEL_API snrxk_TransactionInput* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_transaction_input_copy(
    const snrxk_TransactionInput* transaction_input) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Get the transaction out point. The returned transaction out point is
 * not owned and depends on the lifetime of the transaction.
 *
 * @param[in] transaction_input Non-null.
 * @return                      The transaction out point.
 */
BITCOINKERNEL_API const snrxk_TransactionOutPoint* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_transaction_input_get_out_point(
    const snrxk_TransactionInput* transaction_input) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Get a transaction input's nSequence value.
 *
 * @param[in] transaction_input Non-null.
 * @return                      The nSequence value.
 */
BITCOINKERNEL_API uint32_t BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_transaction_input_get_sequence(
    const snrxk_TransactionInput* transaction_input) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * Destroy the transaction input.
 */
BITCOINKERNEL_API void snrxk_transaction_input_destroy(snrxk_TransactionInput* transaction_input);

///@}

/** @name Transaction Out Point
 * Functions for working with transaction out points.
 */
///@{

/**
 * @brief Copy a transaction out point.
 *
 * @param[in] transaction_out_point Non-null.
 * @return                          The copied transaction out point.
 */
BITCOINKERNEL_API snrxk_TransactionOutPoint* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_transaction_out_point_copy(
    const snrxk_TransactionOutPoint* transaction_out_point) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Get the output position from the transaction out point.
 *
 * @param[in] transaction_out_point Non-null.
 * @return                          The output index.
 */
BITCOINKERNEL_API uint32_t BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_transaction_out_point_get_index(
    const snrxk_TransactionOutPoint* transaction_out_point) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Get the txid from the transaction out point. The returned txid is
 * not owned and depends on the lifetime of the transaction out point.
 *
 * @param[in] transaction_out_point Non-null.
 * @return                          The txid.
 */
BITCOINKERNEL_API const snrxk_Txid* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_transaction_out_point_get_txid(
    const snrxk_TransactionOutPoint* transaction_out_point) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * Destroy the transaction out point.
 */
BITCOINKERNEL_API void snrxk_transaction_out_point_destroy(snrxk_TransactionOutPoint* transaction_out_point);

///@}

/** @name Txid
 * Functions for working with txids.
 */
///@{

/**
 * @brief Copy a txid.
 *
 * @param[in] txid Non-null.
 * @return         The copied txid.
 */
BITCOINKERNEL_API snrxk_Txid* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_txid_copy(
    const snrxk_Txid* txid) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Check if two txids are equal.
 *
 * @param[in] txid1 Non-null.
 * @param[in] txid2 Non-null.
 * @return          0 if the txid is not equal.
 */
BITCOINKERNEL_API int BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_txid_equals(
    const snrxk_Txid* txid1, const snrxk_Txid* txid2) BITCOINKERNEL_ARG_NONNULL(1, 2);

/**
 * @brief Serializes the txid to bytes.
 *
 * @param[in] txid    Non-null.
 * @param[out] output The serialized txid.
 */
BITCOINKERNEL_API void snrxk_txid_to_bytes(
    const snrxk_Txid* txid, unsigned char output[32]) BITCOINKERNEL_ARG_NONNULL(1, 2);

/**
 * Destroy the txid.
 */
BITCOINKERNEL_API void snrxk_txid_destroy(snrxk_Txid* txid);

///@}

/** @name Coin
 * Functions for working with coins.
 */
///@{

/**
 * @brief Copy a coin.
 *
 * @param[in] coin Non-null.
 * @return         The copied coin.
 */
BITCOINKERNEL_API snrxk_Coin* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_coin_copy(
    const snrxk_Coin* coin) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Returns the block height where the transaction that
 * created this coin was included in.
 *
 * @param[in] coin Non-null.
 * @return         The block height of the coin.
 */
BITCOINKERNEL_API uint32_t BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_coin_confirmation_height(
    const snrxk_Coin* coin) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Returns whether the containing transaction was a coinbase.
 *
 * @param[in] coin Non-null.
 * @return         1 if the coin is a coinbase coin, 0 otherwise.
 */
BITCOINKERNEL_API int BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_coin_is_coinbase(
    const snrxk_Coin* coin) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Return the transaction output of a coin. The returned pointer is
 * unowned and only valid for the lifetime of the coin.
 *
 * @param[in] coin Non-null.
 * @return         A transaction output pointer.
 */
BITCOINKERNEL_API const snrxk_TransactionOutput* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_coin_get_output(
    const snrxk_Coin* coin) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * Destroy the coin.
 */
BITCOINKERNEL_API void snrxk_coin_destroy(snrxk_Coin* coin);

///@}

/** @name BlockHash
 * Functions for working with block hashes.
 */
///@{

/**
 * @brief Create a block hash from its raw data.
 */
BITCOINKERNEL_API snrxk_BlockHash* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_hash_create(
    const unsigned char block_hash[32]) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Check if two block hashes are equal.
 *
 * @param[in] hash1 Non-null.
 * @param[in] hash2 Non-null.
 * @return          0 if the block hashes are not equal.
 */
BITCOINKERNEL_API int BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_hash_equals(
    const snrxk_BlockHash* hash1, const snrxk_BlockHash* hash2) BITCOINKERNEL_ARG_NONNULL(1, 2);

/**
 * @brief Copy a block hash.
 *
 * @param[in] block_hash Non-null.
 * @return               The copied block hash.
 */
BITCOINKERNEL_API snrxk_BlockHash* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_hash_copy(
    const snrxk_BlockHash* block_hash) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Serializes the block hash to bytes.
 *
 * @param[in] block_hash     Non-null.
 * @param[in] output         The serialized block hash.
 */
BITCOINKERNEL_API void snrxk_block_hash_to_bytes(
    const snrxk_BlockHash* block_hash, unsigned char output[32]) BITCOINKERNEL_ARG_NONNULL(1, 2);

/**
 * Destroy the block hash.
 */
BITCOINKERNEL_API void snrxk_block_hash_destroy(snrxk_BlockHash* block_hash);

///@}

/**
 * @name Block Header
 * Functions for working with block headers.
 */
///@{

/**
 * @brief Create a snrxk_BlockHeader from serialized data.
 *
 * @param[in] raw_block_header      Non-null, serialized header data (80 bytes)
 * @param[in] raw_block_header_len  Length of serialized header (must be 80)
 * @return                          snrxk_BlockHeader, or null on error.
 */
BITCOINKERNEL_API snrxk_BlockHeader* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_header_create(
    const void* raw_block_header, size_t raw_block_header_len);

/**
 * @brief Copy a snrxk_BlockHeader.
 *
 * @param[in] header    Non-null snrxk_BlockHeader.
 * @return              Copied snrxk_BlockHeader.
 */
BITCOINKERNEL_API snrxk_BlockHeader* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_header_copy(
    const snrxk_BlockHeader* header) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Get the snrxk_BlockHash.
 *
 * @param[in] header    Non-null header
 * @return              snrxk_BlockHash.
 */
BITCOINKERNEL_API snrxk_BlockHash* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_header_get_hash(
    const snrxk_BlockHeader* header) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Get the previous snrxk_BlockHash from snrxk_BlockHeader. The returned hash
 * is unowned and only valid for the lifetime of the snrxk_BlockHeader.
 *
 * @param[in] header    Non-null snrxk_BlockHeader
 * @return              Previous snrxk_BlockHash
 */
BITCOINKERNEL_API const snrxk_BlockHash* BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_header_get_prev_hash(
    const snrxk_BlockHeader* header) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Get the timestamp from snrxk_BlockHeader.
 *
 * @param[in] header    Non-null snrxk_BlockHeader
 * @return              Block timestamp (Unix epoch seconds)
 */
BITCOINKERNEL_API uint32_t BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_header_get_timestamp(
    const snrxk_BlockHeader* header) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Get the nBits difficulty target from snrxk_BlockHeader.
 *
 * @param[in] header    Non-null snrxk_BlockHeader
 * @return              Difficulty target (compact format)
 */
BITCOINKERNEL_API uint32_t BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_header_get_bits(
    const snrxk_BlockHeader* header) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Get the version from snrxk_BlockHeader.
 *
 * @param[in] header    Non-null snrxk_BlockHeader
 * @return              Block version
 */
BITCOINKERNEL_API int32_t BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_header_get_version(
    const snrxk_BlockHeader* header) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * @brief Get the nonce from snrxk_BlockHeader.
 *
 * @param[in] header    Non-null snrxk_BlockHeader
 * @return              Nonce
 */
BITCOINKERNEL_API uint32_t BITCOINKERNEL_WARN_UNUSED_RESULT snrxk_block_header_get_nonce(
    const snrxk_BlockHeader* header) BITCOINKERNEL_ARG_NONNULL(1);

/**
 * Destroy the snrxk_BlockHeader.
 */
BITCOINKERNEL_API void snrxk_block_header_destroy(snrxk_BlockHeader* header);

///@}

#ifdef __cplusplus
} // extern "C"
#endif // __cplusplus

#endif // BITCOIN_KERNEL_BITCOINKERNEL_H
