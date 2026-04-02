// Copyright (c) 2022-present The Synorix Core developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#define BITCOINKERNEL_BUILD

#include <kernel/synorixkernel.h>

#include <chain.h>
#include <coins.h>
#include <consensus/validation.h>
#include <dbwrapper.h>
#include <kernel/caches.h>
#include <kernel/chainparams.h>
#include <kernel/checks.h>
#include <kernel/context.h>
#include <kernel/notifications_interface.h>
#include <kernel/warning.h>
#include <logging.h>
#include <node/blockstorage.h>
#include <node/chainstate.h>
#include <primitives/block.h>
#include <primitives/transaction.h>
#include <script/interpreter.h>
#include <script/script.h>
#include <serialize.h>
#include <streams.h>
#include <sync.h>
#include <uint256.h>
#include <undo.h>
#include <util/check.h>
#include <util/fs.h>
#include <util/result.h>
#include <util/signalinterrupt.h>
#include <util/task_runner.h>
#include <util/translation.h>
#include <validation.h>
#include <validationinterface.h>

#include <cstddef>
#include <cstring>
#include <exception>
#include <functional>
#include <list>
#include <memory>
#include <span>
#include <stdexcept>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

using kernel::ChainstateRole;
using util::ImmediateTaskRunner;

// Define G_TRANSLATION_FUN symbol in libsynorixkernel library so users of the
// library aren't required to export this symbol
extern const TranslateFn G_TRANSLATION_FUN{nullptr};

static const kernel::Context snrxk_context_static{};

namespace {

bool is_valid_flag_combination(script_verify_flags flags)
{
    if (flags & SCRIPT_VERIFY_CLEANSTACK && ~flags & (SCRIPT_VERIFY_P2SH | SCRIPT_VERIFY_WITNESS)) return false;
    if (flags & SCRIPT_VERIFY_WITNESS && ~flags & SCRIPT_VERIFY_P2SH) return false;
    return true;
}

class WriterStream
{
private:
    snrxk_WriteBytes m_writer;
    void* m_user_data;

public:
    WriterStream(snrxk_WriteBytes writer, void* user_data)
        : m_writer{writer}, m_user_data{user_data} {}

    //
    // Stream subset
    //
    void write(std::span<const std::byte> src)
    {
        if (m_writer(src.data(), src.size(), m_user_data) != 0) {
            throw std::runtime_error("Failed to write serialization data");
        }
    }

    template <typename T>
    WriterStream& operator<<(const T& obj)
    {
        ::Serialize(*this, obj);
        return *this;
    }
};

template <typename C, typename CPP>
struct Handle {
    static C* ref(CPP* cpp_type)
    {
        return reinterpret_cast<C*>(cpp_type);
    }

    static const C* ref(const CPP* cpp_type)
    {
        return reinterpret_cast<const C*>(cpp_type);
    }

    template <typename... Args>
    static C* create(Args&&... args)
    {
        auto cpp_obj{std::make_unique<CPP>(std::forward<Args>(args)...)};
        return ref(cpp_obj.release());
    }

    static C* copy(const C* ptr)
    {
        auto cpp_obj{std::make_unique<CPP>(get(ptr))};
        return ref(cpp_obj.release());
    }

    static const CPP& get(const C* ptr)
    {
        return *reinterpret_cast<const CPP*>(ptr);
    }

    static CPP& get(C* ptr)
    {
        return *reinterpret_cast<CPP*>(ptr);
    }

    static void operator delete(void* ptr)
    {
        delete reinterpret_cast<CPP*>(ptr);
    }
};

} // namespace

struct snrxk_BlockTreeEntry: Handle<snrxk_BlockTreeEntry, CBlockIndex> {};
struct snrxk_Block : Handle<snrxk_Block, std::shared_ptr<const CBlock>> {};
struct snrxk_BlockValidationState : Handle<snrxk_BlockValidationState, BlockValidationState> {};

namespace {

BCLog::Level get_bclog_level(snrxk_LogLevel level)
{
    switch (level) {
    case snrxk_LogLevel_INFO: {
        return BCLog::Level::Info;
    }
    case snrxk_LogLevel_DEBUG: {
        return BCLog::Level::Debug;
    }
    case snrxk_LogLevel_TRACE: {
        return BCLog::Level::Trace;
    }
    }
    assert(false);
}

BCLog::LogFlags get_bclog_flag(snrxk_LogCategory category)
{
    switch (category) {
    case snrxk_LogCategory_BENCH: {
        return BCLog::LogFlags::BENCH;
    }
    case snrxk_LogCategory_BLOCKSTORAGE: {
        return BCLog::LogFlags::BLOCKSTORAGE;
    }
    case snrxk_LogCategory_COINDB: {
        return BCLog::LogFlags::COINDB;
    }
    case snrxk_LogCategory_LEVELDB: {
        return BCLog::LogFlags::LEVELDB;
    }
    case snrxk_LogCategory_MEMPOOL: {
        return BCLog::LogFlags::MEMPOOL;
    }
    case snrxk_LogCategory_PRUNE: {
        return BCLog::LogFlags::PRUNE;
    }
    case snrxk_LogCategory_RAND: {
        return BCLog::LogFlags::RAND;
    }
    case snrxk_LogCategory_REINDEX: {
        return BCLog::LogFlags::REINDEX;
    }
    case snrxk_LogCategory_VALIDATION: {
        return BCLog::LogFlags::VALIDATION;
    }
    case snrxk_LogCategory_KERNEL: {
        return BCLog::LogFlags::KERNEL;
    }
    case snrxk_LogCategory_ALL: {
        return BCLog::LogFlags::ALL;
    }
    }
    assert(false);
}

snrxk_SynchronizationState cast_state(SynchronizationState state)
{
    switch (state) {
    case SynchronizationState::INIT_REINDEX:
        return snrxk_SynchronizationState_INIT_REINDEX;
    case SynchronizationState::INIT_DOWNLOAD:
        return snrxk_SynchronizationState_INIT_DOWNLOAD;
    case SynchronizationState::POST_INIT:
        return snrxk_SynchronizationState_POST_INIT;
    } // no default case, so the compiler can warn about missing cases
    assert(false);
}

snrxk_Warning cast_snrxk_warning(kernel::Warning warning)
{
    switch (warning) {
    case kernel::Warning::UNKNOWN_NEW_RULES_ACTIVATED:
        return snrxk_Warning_UNKNOWN_NEW_RULES_ACTIVATED;
    case kernel::Warning::LARGE_WORK_INVALID_CHAIN:
        return snrxk_Warning_LARGE_WORK_INVALID_CHAIN;
    } // no default case, so the compiler can warn about missing cases
    assert(false);
}

struct LoggingConnection {
    std::unique_ptr<std::list<std::function<void(const std::string&)>>::iterator> m_connection;
    void* m_user_data;
    std::function<void(void* user_data)> m_deleter;

    LoggingConnection(snrxk_LogCallback callback, void* user_data, snrxk_DestroyCallback user_data_destroy_callback)
    {
        LOCK(cs_main);

        auto connection{LogInstance().PushBackCallback([callback, user_data](const std::string& str) { callback(user_data, str.c_str(), str.length()); })};

        // Only start logging if we just added the connection.
        if (LogInstance().NumConnections() == 1 && !LogInstance().StartLogging()) {
            LogError("Logger start failed.");
            LogInstance().DeleteCallback(connection);
            if (user_data && user_data_destroy_callback) {
                user_data_destroy_callback(user_data);
            }
            throw std::runtime_error("Failed to start logging");
        }

        m_connection = std::make_unique<std::list<std::function<void(const std::string&)>>::iterator>(connection);
        m_user_data = user_data;
        m_deleter = user_data_destroy_callback;

        LogDebug(BCLog::KERNEL, "Logger connected.");
    }

    ~LoggingConnection()
    {
        LOCK(cs_main);
        LogDebug(BCLog::KERNEL, "Logger disconnecting.");

        // Switch back to buffering by calling DisconnectTestLogger if the
        // connection that we are about to remove is the last one.
        if (LogInstance().NumConnections() == 1) {
            LogInstance().DisconnectTestLogger();
        } else {
            LogInstance().DeleteCallback(*m_connection);
        }

        m_connection.reset();
        if (m_user_data && m_deleter) {
            m_deleter(m_user_data);
        }
    }
};

class KernelNotifications final : public kernel::Notifications
{
private:
    snrxk_NotificationInterfaceCallbacks m_cbs;

public:
    KernelNotifications(snrxk_NotificationInterfaceCallbacks cbs)
        : m_cbs{cbs}
    {
    }

    ~KernelNotifications()
    {
        if (m_cbs.user_data && m_cbs.user_data_destroy) {
            m_cbs.user_data_destroy(m_cbs.user_data);
        }
        m_cbs.user_data_destroy = nullptr;
        m_cbs.user_data = nullptr;
    }

    kernel::InterruptResult blockTip(SynchronizationState state, const CBlockIndex& index, double verification_progress) override
    {
        if (m_cbs.block_tip) m_cbs.block_tip(m_cbs.user_data, cast_state(state), snrxk_BlockTreeEntry::ref(&index), verification_progress);
        return {};
    }
    void headerTip(SynchronizationState state, int64_t height, int64_t timestamp, bool presync) override
    {
        if (m_cbs.header_tip) m_cbs.header_tip(m_cbs.user_data, cast_state(state), height, timestamp, presync ? 1 : 0);
    }
    void progress(const bilingual_str& title, int progress_percent, bool resume_possible) override
    {
        if (m_cbs.progress) m_cbs.progress(m_cbs.user_data, title.original.c_str(), title.original.length(), progress_percent, resume_possible ? 1 : 0);
    }
    void warningSet(kernel::Warning id, const bilingual_str& message) override
    {
        if (m_cbs.warning_set) m_cbs.warning_set(m_cbs.user_data, cast_snrxk_warning(id), message.original.c_str(), message.original.length());
    }
    void warningUnset(kernel::Warning id) override
    {
        if (m_cbs.warning_unset) m_cbs.warning_unset(m_cbs.user_data, cast_snrxk_warning(id));
    }
    void flushError(const bilingual_str& message) override
    {
        if (m_cbs.flush_error) m_cbs.flush_error(m_cbs.user_data, message.original.c_str(), message.original.length());
    }
    void fatalError(const bilingual_str& message) override
    {
        if (m_cbs.fatal_error) m_cbs.fatal_error(m_cbs.user_data, message.original.c_str(), message.original.length());
    }
};

class KernelValidationInterface final : public CValidationInterface
{
public:
    snrxk_ValidationInterfaceCallbacks m_cbs;

    explicit KernelValidationInterface(const snrxk_ValidationInterfaceCallbacks vi_cbs) : m_cbs{vi_cbs} {}

    ~KernelValidationInterface()
    {
        if (m_cbs.user_data && m_cbs.user_data_destroy) {
            m_cbs.user_data_destroy(m_cbs.user_data);
        }
        m_cbs.user_data = nullptr;
        m_cbs.user_data_destroy = nullptr;
    }

protected:
    void BlockChecked(const std::shared_ptr<const CBlock>& block, const BlockValidationState& stateIn) override
    {
        if (m_cbs.block_checked) {
            m_cbs.block_checked(m_cbs.user_data,
                                snrxk_Block::copy(snrxk_Block::ref(&block)),
                                snrxk_BlockValidationState::ref(&stateIn));
        }
    }

    void NewPoWValidBlock(const CBlockIndex* pindex, const std::shared_ptr<const CBlock>& block) override
    {
        if (m_cbs.pow_valid_block) {
            m_cbs.pow_valid_block(m_cbs.user_data,
                                  snrxk_Block::copy(snrxk_Block::ref(&block)),
                                  snrxk_BlockTreeEntry::ref(pindex));
        }
    }

    void BlockConnected(const ChainstateRole& role, const std::shared_ptr<const CBlock>& block, const CBlockIndex* pindex) override
    {
        if (m_cbs.block_connected) {
            m_cbs.block_connected(m_cbs.user_data,
                                  snrxk_Block::copy(snrxk_Block::ref(&block)),
                                  snrxk_BlockTreeEntry::ref(pindex));
        }
    }

    void BlockDisconnected(const std::shared_ptr<const CBlock>& block, const CBlockIndex* pindex) override
    {
        if (m_cbs.block_disconnected) {
            m_cbs.block_disconnected(m_cbs.user_data,
                                     snrxk_Block::copy(snrxk_Block::ref(&block)),
                                     snrxk_BlockTreeEntry::ref(pindex));
        }
    }
};

struct ContextOptions {
    mutable Mutex m_mutex;
    std::unique_ptr<const CChainParams> m_chainparams GUARDED_BY(m_mutex);
    std::shared_ptr<KernelNotifications> m_notifications GUARDED_BY(m_mutex);
    std::shared_ptr<KernelValidationInterface> m_validation_interface GUARDED_BY(m_mutex);
};

class Context
{
public:
    std::unique_ptr<kernel::Context> m_context;

    std::shared_ptr<KernelNotifications> m_notifications;

    std::unique_ptr<util::SignalInterrupt> m_interrupt;

    std::unique_ptr<ValidationSignals> m_signals;

    std::unique_ptr<const CChainParams> m_chainparams;

    std::shared_ptr<KernelValidationInterface> m_validation_interface;

    Context(const ContextOptions* options, bool& sane)
        : m_context{std::make_unique<kernel::Context>()},
          m_interrupt{std::make_unique<util::SignalInterrupt>()}
    {
        if (options) {
            LOCK(options->m_mutex);
            if (options->m_chainparams) {
                m_chainparams = std::make_unique<const CChainParams>(*options->m_chainparams);
            }
            if (options->m_notifications) {
                m_notifications = options->m_notifications;
            }
            if (options->m_validation_interface) {
                m_signals = std::make_unique<ValidationSignals>(std::make_unique<ImmediateTaskRunner>());
                m_validation_interface = options->m_validation_interface;
                m_signals->RegisterSharedValidationInterface(m_validation_interface);
            }
        }

        if (!m_chainparams) {
            m_chainparams = CChainParams::Main();
        }
        if (!m_notifications) {
            m_notifications = std::make_shared<KernelNotifications>(snrxk_NotificationInterfaceCallbacks{
                nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr});
        }

        if (!kernel::SanityChecks(*m_context)) {
            sane = false;
        }
    }

    ~Context()
    {
        if (m_signals) {
            m_signals->UnregisterSharedValidationInterface(m_validation_interface);
        }
    }
};

//! Helper struct to wrap the ChainstateManager-related Options
struct ChainstateManagerOptions {
    mutable Mutex m_mutex;
    ChainstateManager::Options m_chainman_options GUARDED_BY(m_mutex);
    node::BlockManager::Options m_blockman_options GUARDED_BY(m_mutex);
    std::shared_ptr<const Context> m_context;
    node::ChainstateLoadOptions m_chainstate_load_options GUARDED_BY(m_mutex);

    ChainstateManagerOptions(const std::shared_ptr<const Context>& context, const fs::path& data_dir, const fs::path& blocks_dir)
        : m_chainman_options{ChainstateManager::Options{
              .chainparams = *context->m_chainparams,
              .datadir = data_dir,
              .notifications = *context->m_notifications,
              .signals = context->m_signals.get()}},
          m_blockman_options{node::BlockManager::Options{
              .chainparams = *context->m_chainparams,
              .blocks_dir = blocks_dir,
              .notifications = *context->m_notifications,
              .block_tree_db_params = DBParams{
                  .path = data_dir / "blocks" / "index",
                  .cache_bytes = kernel::CacheSizes{DEFAULT_KERNEL_CACHE}.block_tree_db,
              }}},
          m_context{context}, m_chainstate_load_options{node::ChainstateLoadOptions{}}
    {
    }
};

struct ChainMan {
    std::unique_ptr<ChainstateManager> m_chainman;
    std::shared_ptr<const Context> m_context;

    ChainMan(std::unique_ptr<ChainstateManager> chainman, std::shared_ptr<const Context> context)
        : m_chainman(std::move(chainman)), m_context(std::move(context)) {}
};

} // namespace

struct snrxk_Transaction : Handle<snrxk_Transaction, std::shared_ptr<const CTransaction>> {};
struct snrxk_TransactionOutput : Handle<snrxk_TransactionOutput, CTxOut> {};
struct snrxk_ScriptPubkey : Handle<snrxk_ScriptPubkey, CScript> {};
struct snrxk_LoggingConnection : Handle<snrxk_LoggingConnection, LoggingConnection> {};
struct snrxk_ContextOptions : Handle<snrxk_ContextOptions, ContextOptions> {};
struct snrxk_Context : Handle<snrxk_Context, std::shared_ptr<const Context>> {};
struct snrxk_ChainParameters : Handle<snrxk_ChainParameters, CChainParams> {};
struct snrxk_ChainstateManagerOptions : Handle<snrxk_ChainstateManagerOptions, ChainstateManagerOptions> {};
struct snrxk_ChainstateManager : Handle<snrxk_ChainstateManager, ChainMan> {};
struct snrxk_Chain : Handle<snrxk_Chain, CChain> {};
struct snrxk_BlockSpentOutputs : Handle<snrxk_BlockSpentOutputs, std::shared_ptr<CBlockUndo>> {};
struct snrxk_TransactionSpentOutputs : Handle<snrxk_TransactionSpentOutputs, CTxUndo> {};
struct snrxk_Coin : Handle<snrxk_Coin, Coin> {};
struct snrxk_BlockHash : Handle<snrxk_BlockHash, uint256> {};
struct snrxk_TransactionInput : Handle<snrxk_TransactionInput, CTxIn> {};
struct snrxk_TransactionOutPoint: Handle<snrxk_TransactionOutPoint, COutPoint> {};
struct snrxk_Txid: Handle<snrxk_Txid, Txid> {};
struct snrxk_PrecomputedTransactionData : Handle<snrxk_PrecomputedTransactionData, PrecomputedTransactionData> {};
struct snrxk_BlockHeader: Handle<snrxk_BlockHeader, CBlockHeader> {};

snrxk_Transaction* snrxk_transaction_create(const void* raw_transaction, size_t raw_transaction_len)
{
    if (raw_transaction == nullptr && raw_transaction_len != 0) {
        return nullptr;
    }
    try {
        SpanReader stream{std::span{reinterpret_cast<const std::byte*>(raw_transaction), raw_transaction_len}};
        return snrxk_Transaction::create(std::make_shared<const CTransaction>(deserialize, TX_WITH_WITNESS, stream));
    } catch (...) {
        return nullptr;
    }
}

size_t snrxk_transaction_count_outputs(const snrxk_Transaction* transaction)
{
    return snrxk_Transaction::get(transaction)->vout.size();
}

const snrxk_TransactionOutput* snrxk_transaction_get_output_at(const snrxk_Transaction* transaction, size_t output_index)
{
    const CTransaction& tx = *snrxk_Transaction::get(transaction);
    assert(output_index < tx.vout.size());
    return snrxk_TransactionOutput::ref(&tx.vout[output_index]);
}

size_t snrxk_transaction_count_inputs(const snrxk_Transaction* transaction)
{
    return snrxk_Transaction::get(transaction)->vin.size();
}

const snrxk_TransactionInput* snrxk_transaction_get_input_at(const snrxk_Transaction* transaction, size_t input_index)
{
    assert(input_index < snrxk_Transaction::get(transaction)->vin.size());
    return snrxk_TransactionInput::ref(&snrxk_Transaction::get(transaction)->vin[input_index]);
}

uint32_t snrxk_transaction_get_locktime(const snrxk_Transaction* transaction)
{
    return snrxk_Transaction::get(transaction)->nLockTime;
}

const snrxk_Txid* snrxk_transaction_get_txid(const snrxk_Transaction* transaction)
{
    return snrxk_Txid::ref(&snrxk_Transaction::get(transaction)->GetHash());
}

snrxk_Transaction* snrxk_transaction_copy(const snrxk_Transaction* transaction)
{
    return snrxk_Transaction::copy(transaction);
}

int snrxk_transaction_to_bytes(const snrxk_Transaction* transaction, snrxk_WriteBytes writer, void* user_data)
{
    try {
        WriterStream ws{writer, user_data};
        ws << TX_WITH_WITNESS(snrxk_Transaction::get(transaction));
        return 0;
    } catch (...) {
        return -1;
    }
}

void snrxk_transaction_destroy(snrxk_Transaction* transaction)
{
    delete transaction;
}

snrxk_ScriptPubkey* snrxk_script_pubkey_create(const void* script_pubkey, size_t script_pubkey_len)
{
    if (script_pubkey == nullptr && script_pubkey_len != 0) {
        return nullptr;
    }
    auto data = std::span{reinterpret_cast<const uint8_t*>(script_pubkey), script_pubkey_len};
    return snrxk_ScriptPubkey::create(data.begin(), data.end());
}

int snrxk_script_pubkey_to_bytes(const snrxk_ScriptPubkey* script_pubkey_, snrxk_WriteBytes writer, void* user_data)
{
    const auto& script_pubkey{snrxk_ScriptPubkey::get(script_pubkey_)};
    return writer(script_pubkey.data(), script_pubkey.size(), user_data);
}

snrxk_ScriptPubkey* snrxk_script_pubkey_copy(const snrxk_ScriptPubkey* script_pubkey)
{
    return snrxk_ScriptPubkey::copy(script_pubkey);
}

void snrxk_script_pubkey_destroy(snrxk_ScriptPubkey* script_pubkey)
{
    delete script_pubkey;
}

snrxk_TransactionOutput* snrxk_transaction_output_create(const snrxk_ScriptPubkey* script_pubkey, int64_t amount)
{
    return snrxk_TransactionOutput::create(amount, snrxk_ScriptPubkey::get(script_pubkey));
}

snrxk_TransactionOutput* snrxk_transaction_output_copy(const snrxk_TransactionOutput* output)
{
    return snrxk_TransactionOutput::copy(output);
}

const snrxk_ScriptPubkey* snrxk_transaction_output_get_script_pubkey(const snrxk_TransactionOutput* output)
{
    return snrxk_ScriptPubkey::ref(&snrxk_TransactionOutput::get(output).scriptPubKey);
}

int64_t snrxk_transaction_output_get_amount(const snrxk_TransactionOutput* output)
{
    return snrxk_TransactionOutput::get(output).nValue;
}

void snrxk_transaction_output_destroy(snrxk_TransactionOutput* output)
{
    delete output;
}

snrxk_PrecomputedTransactionData* snrxk_precomputed_transaction_data_create(
    const snrxk_Transaction* tx_to,
    const snrxk_TransactionOutput** spent_outputs_, size_t spent_outputs_len)
{
    try {
        const CTransaction& tx{*snrxk_Transaction::get(tx_to)};
        auto txdata{snrxk_PrecomputedTransactionData::create()};
        if (spent_outputs_ != nullptr && spent_outputs_len > 0) {
            assert(spent_outputs_len == tx.vin.size());
            std::vector<CTxOut> spent_outputs;
            spent_outputs.reserve(spent_outputs_len);
            for (size_t i = 0; i < spent_outputs_len; i++) {
                const CTxOut& tx_out{snrxk_TransactionOutput::get(spent_outputs_[i])};
                spent_outputs.push_back(tx_out);
            }
            snrxk_PrecomputedTransactionData::get(txdata).Init(tx, std::move(spent_outputs));
        } else {
            snrxk_PrecomputedTransactionData::get(txdata).Init(tx, {});
        }

        return txdata;
    } catch (...) {
        return nullptr;
    }
}

snrxk_PrecomputedTransactionData* snrxk_precomputed_transaction_data_copy(const snrxk_PrecomputedTransactionData* precomputed_txdata)
{
    return snrxk_PrecomputedTransactionData::copy(precomputed_txdata);
}

void snrxk_precomputed_transaction_data_destroy(snrxk_PrecomputedTransactionData* precomputed_txdata)
{
    delete precomputed_txdata;
}

int snrxk_script_pubkey_verify(const snrxk_ScriptPubkey* script_pubkey,
                              const int64_t amount,
                              const snrxk_Transaction* tx_to,
                              const snrxk_PrecomputedTransactionData* precomputed_txdata,
                              const unsigned int input_index,
                              const snrxk_ScriptVerificationFlags flags,
                              snrxk_ScriptVerifyStatus* status)
{
    // Assert that all specified flags are part of the interface before continuing
    assert((flags & ~snrxk_ScriptVerificationFlags_ALL) == 0);

    if (!is_valid_flag_combination(script_verify_flags::from_int(flags))) {
        if (status) *status = snrxk_ScriptVerifyStatus_ERROR_INVALID_FLAGS_COMBINATION;
        return 0;
    }

    const CTransaction& tx{*snrxk_Transaction::get(tx_to)};
    assert(input_index < tx.vin.size());

    const PrecomputedTransactionData& txdata{precomputed_txdata ? snrxk_PrecomputedTransactionData::get(precomputed_txdata) : PrecomputedTransactionData(tx)};

    if (flags & snrxk_ScriptVerificationFlags_TAPROOT && txdata.m_spent_outputs.empty()) {
        if (status) *status = snrxk_ScriptVerifyStatus_ERROR_SPENT_OUTPUTS_REQUIRED;
        return 0;
    }

    if (status) *status = snrxk_ScriptVerifyStatus_OK;

    bool result = VerifyScript(tx.vin[input_index].scriptSig,
                               snrxk_ScriptPubkey::get(script_pubkey),
                               &tx.vin[input_index].scriptWitness,
                               script_verify_flags::from_int(flags),
                               TransactionSignatureChecker(&tx, input_index, amount, txdata, MissingDataBehavior::FAIL),
                               nullptr);
    return result ? 1 : 0;
}

snrxk_TransactionInput* snrxk_transaction_input_copy(const snrxk_TransactionInput* input)
{
    return snrxk_TransactionInput::copy(input);
}

const snrxk_TransactionOutPoint* snrxk_transaction_input_get_out_point(const snrxk_TransactionInput* input)
{
    return snrxk_TransactionOutPoint::ref(&snrxk_TransactionInput::get(input).prevout);
}

uint32_t snrxk_transaction_input_get_sequence(const snrxk_TransactionInput* input)
{
    return snrxk_TransactionInput::get(input).nSequence;
}

void snrxk_transaction_input_destroy(snrxk_TransactionInput* input)
{
    delete input;
}

snrxk_TransactionOutPoint* snrxk_transaction_out_point_copy(const snrxk_TransactionOutPoint* out_point)
{
    return snrxk_TransactionOutPoint::copy(out_point);
}

uint32_t snrxk_transaction_out_point_get_index(const snrxk_TransactionOutPoint* out_point)
{
    return snrxk_TransactionOutPoint::get(out_point).n;
}

const snrxk_Txid* snrxk_transaction_out_point_get_txid(const snrxk_TransactionOutPoint* out_point)
{
    return snrxk_Txid::ref(&snrxk_TransactionOutPoint::get(out_point).hash);
}

void snrxk_transaction_out_point_destroy(snrxk_TransactionOutPoint* out_point)
{
    delete out_point;
}

snrxk_Txid* snrxk_txid_copy(const snrxk_Txid* txid)
{
    return snrxk_Txid::copy(txid);
}

void snrxk_txid_to_bytes(const snrxk_Txid* txid, unsigned char output[32])
{
    std::memcpy(output, snrxk_Txid::get(txid).begin(), 32);
}

int snrxk_txid_equals(const snrxk_Txid* txid1, const snrxk_Txid* txid2)
{
    return snrxk_Txid::get(txid1) == snrxk_Txid::get(txid2);
}

void snrxk_txid_destroy(snrxk_Txid* txid)
{
    delete txid;
}

void snrxk_logging_set_options(const snrxk_LoggingOptions options)
{
    LOCK(cs_main);
    LogInstance().m_log_timestamps = options.log_timestamps;
    LogInstance().m_log_time_micros = options.log_time_micros;
    LogInstance().m_log_threadnames = options.log_threadnames;
    LogInstance().m_log_sourcelocations = options.log_sourcelocations;
    LogInstance().m_always_print_category_level = options.always_print_category_levels;
}

void snrxk_logging_set_level_category(snrxk_LogCategory category, snrxk_LogLevel level)
{
    LOCK(cs_main);
    if (category == snrxk_LogCategory_ALL) {
        LogInstance().SetLogLevel(get_bclog_level(level));
    }

    LogInstance().AddCategoryLogLevel(get_bclog_flag(category), get_bclog_level(level));
}

void snrxk_logging_enable_category(snrxk_LogCategory category)
{
    LogInstance().EnableCategory(get_bclog_flag(category));
}

void snrxk_logging_disable_category(snrxk_LogCategory category)
{
    LogInstance().DisableCategory(get_bclog_flag(category));
}

void snrxk_logging_disable()
{
    LogInstance().DisableLogging();
}

snrxk_LoggingConnection* snrxk_logging_connection_create(snrxk_LogCallback callback, void* user_data, snrxk_DestroyCallback user_data_destroy_callback)
{
    try {
        return snrxk_LoggingConnection::create(callback, user_data, user_data_destroy_callback);
    } catch (const std::exception&) {
        return nullptr;
    }
}

void snrxk_logging_connection_destroy(snrxk_LoggingConnection* connection)
{
    delete connection;
}

snrxk_ChainParameters* snrxk_chain_parameters_create(const snrxk_ChainType chain_type)
{
    switch (chain_type) {
    case snrxk_ChainType_MAINNET: {
        return snrxk_ChainParameters::ref(const_cast<CChainParams*>(CChainParams::Main().release()));
    }
    case snrxk_ChainType_TESTNET: {
        return snrxk_ChainParameters::ref(const_cast<CChainParams*>(CChainParams::TestNet().release()));
    }
    case snrxk_ChainType_TESTNET_4: {
        return snrxk_ChainParameters::ref(const_cast<CChainParams*>(CChainParams::TestNet4().release()));
    }
    case snrxk_ChainType_SIGNET: {
        return snrxk_ChainParameters::ref(const_cast<CChainParams*>(CChainParams::SigNet({}).release()));
    }
    case snrxk_ChainType_REGTEST: {
        return snrxk_ChainParameters::ref(const_cast<CChainParams*>(CChainParams::RegTest({}).release()));
    }
    }
    assert(false);
}

snrxk_ChainParameters* snrxk_chain_parameters_copy(const snrxk_ChainParameters* chain_parameters)
{
    return snrxk_ChainParameters::copy(chain_parameters);
}

void snrxk_chain_parameters_destroy(snrxk_ChainParameters* chain_parameters)
{
    delete chain_parameters;
}

snrxk_ContextOptions* snrxk_context_options_create()
{
    return snrxk_ContextOptions::create();
}

void snrxk_context_options_set_chainparams(snrxk_ContextOptions* options, const snrxk_ChainParameters* chain_parameters)
{
    // Copy the chainparams, so the caller can free it again
    LOCK(snrxk_ContextOptions::get(options).m_mutex);
    snrxk_ContextOptions::get(options).m_chainparams = std::make_unique<const CChainParams>(snrxk_ChainParameters::get(chain_parameters));
}

void snrxk_context_options_set_notifications(snrxk_ContextOptions* options, snrxk_NotificationInterfaceCallbacks notifications)
{
    // The KernelNotifications are copy-initialized, so the caller can free them again.
    LOCK(snrxk_ContextOptions::get(options).m_mutex);
    snrxk_ContextOptions::get(options).m_notifications = std::make_shared<KernelNotifications>(notifications);
}

void snrxk_context_options_set_validation_interface(snrxk_ContextOptions* options, snrxk_ValidationInterfaceCallbacks vi_cbs)
{
    LOCK(snrxk_ContextOptions::get(options).m_mutex);
    snrxk_ContextOptions::get(options).m_validation_interface = std::make_shared<KernelValidationInterface>(vi_cbs);
}

void snrxk_context_options_destroy(snrxk_ContextOptions* options)
{
    delete options;
}

snrxk_Context* snrxk_context_create(const snrxk_ContextOptions* options)
{
    bool sane{true};
    const ContextOptions* opts = options ? &snrxk_ContextOptions::get(options) : nullptr;
    auto context{std::make_shared<const Context>(opts, sane)};
    if (!sane) {
        LogError("Kernel context sanity check failed.");
        return nullptr;
    }
    return snrxk_Context::create(context);
}

snrxk_Context* snrxk_context_copy(const snrxk_Context* context)
{
    return snrxk_Context::copy(context);
}

int snrxk_context_interrupt(snrxk_Context* context)
{
    return (*snrxk_Context::get(context)->m_interrupt)() ? 0 : -1;
}

void snrxk_context_destroy(snrxk_Context* context)
{
    delete context;
}

const snrxk_BlockTreeEntry* snrxk_block_tree_entry_get_previous(const snrxk_BlockTreeEntry* entry)
{
    if (!snrxk_BlockTreeEntry::get(entry).pprev) {
        LogInfo("Genesis block has no previous.");
        return nullptr;
    }

    return snrxk_BlockTreeEntry::ref(snrxk_BlockTreeEntry::get(entry).pprev);
}

snrxk_BlockValidationState* snrxk_block_validation_state_create()
{
    return snrxk_BlockValidationState::create();
}

snrxk_BlockValidationState* snrxk_block_validation_state_copy(const snrxk_BlockValidationState* state)
{
    return snrxk_BlockValidationState::copy(state);
}

void snrxk_block_validation_state_destroy(snrxk_BlockValidationState* state)
{
    delete state;
}

snrxk_ValidationMode snrxk_block_validation_state_get_validation_mode(const snrxk_BlockValidationState* block_validation_state_)
{
    auto& block_validation_state = snrxk_BlockValidationState::get(block_validation_state_);
    if (block_validation_state.IsValid()) return snrxk_ValidationMode_VALID;
    if (block_validation_state.IsInvalid()) return snrxk_ValidationMode_INVALID;
    return snrxk_ValidationMode_INTERNAL_ERROR;
}

snrxk_BlockValidationResult snrxk_block_validation_state_get_block_validation_result(const snrxk_BlockValidationState* block_validation_state_)
{
    auto& block_validation_state = snrxk_BlockValidationState::get(block_validation_state_);
    switch (block_validation_state.GetResult()) {
    case BlockValidationResult::BLOCK_RESULT_UNSET:
        return snrxk_BlockValidationResult_UNSET;
    case BlockValidationResult::BLOCK_CONSENSUS:
        return snrxk_BlockValidationResult_CONSENSUS;
    case BlockValidationResult::BLOCK_CACHED_INVALID:
        return snrxk_BlockValidationResult_CACHED_INVALID;
    case BlockValidationResult::BLOCK_INVALID_HEADER:
        return snrxk_BlockValidationResult_INVALID_HEADER;
    case BlockValidationResult::BLOCK_MUTATED:
        return snrxk_BlockValidationResult_MUTATED;
    case BlockValidationResult::BLOCK_MISSING_PREV:
        return snrxk_BlockValidationResult_MISSING_PREV;
    case BlockValidationResult::BLOCK_INVALID_PREV:
        return snrxk_BlockValidationResult_INVALID_PREV;
    case BlockValidationResult::BLOCK_TIME_FUTURE:
        return snrxk_BlockValidationResult_TIME_FUTURE;
    case BlockValidationResult::BLOCK_HEADER_LOW_WORK:
        return snrxk_BlockValidationResult_HEADER_LOW_WORK;
    } // no default case, so the compiler can warn about missing cases
    assert(false);
}

snrxk_ChainstateManagerOptions* snrxk_chainstate_manager_options_create(const snrxk_Context* context, const char* data_dir, size_t data_dir_len, const char* blocks_dir, size_t blocks_dir_len)
{
    if (data_dir == nullptr || data_dir_len == 0 || blocks_dir == nullptr || blocks_dir_len == 0) {
        LogError("Failed to create chainstate manager options: dir must be non-null and non-empty");
        return nullptr;
    }
    try {
        fs::path abs_data_dir{fs::absolute(fs::PathFromString({data_dir, data_dir_len}))};
        fs::create_directories(abs_data_dir);
        fs::path abs_blocks_dir{fs::absolute(fs::PathFromString({blocks_dir, blocks_dir_len}))};
        fs::create_directories(abs_blocks_dir);
        return snrxk_ChainstateManagerOptions::create(snrxk_Context::get(context), abs_data_dir, abs_blocks_dir);
    } catch (const std::exception& e) {
        LogError("Failed to create chainstate manager options: %s", e.what());
        return nullptr;
    }
}

void snrxk_chainstate_manager_options_set_worker_threads_num(snrxk_ChainstateManagerOptions* opts, int worker_threads)
{
    LOCK(snrxk_ChainstateManagerOptions::get(opts).m_mutex);
    snrxk_ChainstateManagerOptions::get(opts).m_chainman_options.worker_threads_num = worker_threads;
}

void snrxk_chainstate_manager_options_destroy(snrxk_ChainstateManagerOptions* options)
{
    delete options;
}

int snrxk_chainstate_manager_options_set_wipe_dbs(snrxk_ChainstateManagerOptions* chainman_opts, int wipe_block_tree_db, int wipe_chainstate_db)
{
    if (wipe_block_tree_db == 1 && wipe_chainstate_db != 1) {
        LogError("Wiping the block tree db without also wiping the chainstate db is currently unsupported.");
        return -1;
    }
    auto& opts{snrxk_ChainstateManagerOptions::get(chainman_opts)};
    LOCK(opts.m_mutex);
    opts.m_blockman_options.block_tree_db_params.wipe_data = wipe_block_tree_db == 1;
    opts.m_chainstate_load_options.wipe_chainstate_db = wipe_chainstate_db == 1;
    return 0;
}

void snrxk_chainstate_manager_options_update_block_tree_db_in_memory(
    snrxk_ChainstateManagerOptions* chainman_opts,
    int block_tree_db_in_memory)
{
    auto& opts{snrxk_ChainstateManagerOptions::get(chainman_opts)};
    LOCK(opts.m_mutex);
    opts.m_blockman_options.block_tree_db_params.memory_only = block_tree_db_in_memory == 1;
}

void snrxk_chainstate_manager_options_update_chainstate_db_in_memory(
    snrxk_ChainstateManagerOptions* chainman_opts,
    int chainstate_db_in_memory)
{
    auto& opts{snrxk_ChainstateManagerOptions::get(chainman_opts)};
    LOCK(opts.m_mutex);
    opts.m_chainstate_load_options.coins_db_in_memory = chainstate_db_in_memory == 1;
}

snrxk_ChainstateManager* snrxk_chainstate_manager_create(
    const snrxk_ChainstateManagerOptions* chainman_opts)
{
    auto& opts{snrxk_ChainstateManagerOptions::get(chainman_opts)};
    std::unique_ptr<ChainstateManager> chainman;
    try {
        LOCK(opts.m_mutex);
        chainman = std::make_unique<ChainstateManager>(*opts.m_context->m_interrupt, opts.m_chainman_options, opts.m_blockman_options);
    } catch (const std::exception& e) {
        LogError("Failed to create chainstate manager: %s", e.what());
        return nullptr;
    }

    try {
        const auto chainstate_load_opts{WITH_LOCK(opts.m_mutex, return opts.m_chainstate_load_options)};

        kernel::CacheSizes cache_sizes{DEFAULT_KERNEL_CACHE};
        auto [status, chainstate_err]{node::LoadChainstate(*chainman, cache_sizes, chainstate_load_opts)};
        if (status != node::ChainstateLoadStatus::SUCCESS) {
            LogError("Failed to load chain state from your data directory: %s", chainstate_err.original);
            return nullptr;
        }
        std::tie(status, chainstate_err) = node::VerifyLoadedChainstate(*chainman, chainstate_load_opts);
        if (status != node::ChainstateLoadStatus::SUCCESS) {
            LogError("Failed to verify loaded chain state from your datadir: %s", chainstate_err.original);
            return nullptr;
        }
        if (auto result = chainman->ActivateBestChains(); !result) {
            LogError("%s", util::ErrorString(result).original);
            return nullptr;
        }
    } catch (const std::exception& e) {
        LogError("Failed to load chainstate: %s", e.what());
        return nullptr;
    }

    return snrxk_ChainstateManager::create(std::move(chainman), opts.m_context);
}

const snrxk_BlockTreeEntry* snrxk_chainstate_manager_get_block_tree_entry_by_hash(const snrxk_ChainstateManager* chainman, const snrxk_BlockHash* block_hash)
{
    auto block_index = WITH_LOCK(snrxk_ChainstateManager::get(chainman).m_chainman->GetMutex(),
                                 return snrxk_ChainstateManager::get(chainman).m_chainman->m_blockman.LookupBlockIndex(snrxk_BlockHash::get(block_hash)));
    if (!block_index) {
        LogDebug(BCLog::KERNEL, "A block with the given hash is not indexed.");
        return nullptr;
    }
    return snrxk_BlockTreeEntry::ref(block_index);
}

const snrxk_BlockTreeEntry* snrxk_chainstate_manager_get_best_entry(const snrxk_ChainstateManager* chainstate_manager)
{
    auto& chainman = *snrxk_ChainstateManager::get(chainstate_manager).m_chainman;
    return snrxk_BlockTreeEntry::ref(WITH_LOCK(chainman.GetMutex(), return chainman.m_best_header));
}

void snrxk_chainstate_manager_destroy(snrxk_ChainstateManager* chainman)
{
    {
        LOCK(snrxk_ChainstateManager::get(chainman).m_chainman->GetMutex());
        for (const auto& chainstate : snrxk_ChainstateManager::get(chainman).m_chainman->m_chainstates) {
            if (chainstate->CanFlushToDisk()) {
                chainstate->ForceFlushStateToDisk();
                chainstate->ResetCoinsViews();
            }
        }
    }

    delete chainman;
}

int snrxk_chainstate_manager_import_blocks(snrxk_ChainstateManager* chainman, const char** block_file_paths_data, size_t* block_file_paths_lens, size_t block_file_paths_data_len)
{
    try {
        std::vector<fs::path> import_files;
        import_files.reserve(block_file_paths_data_len);
        for (uint32_t i = 0; i < block_file_paths_data_len; i++) {
            if (block_file_paths_data[i] != nullptr) {
                import_files.emplace_back(std::string{block_file_paths_data[i], block_file_paths_lens[i]}.c_str());
            }
        }
        auto& chainman_ref{*snrxk_ChainstateManager::get(chainman).m_chainman};
        node::ImportBlocks(chainman_ref, import_files);
        WITH_LOCK(::cs_main, chainman_ref.UpdateIBDStatus());
    } catch (const std::exception& e) {
        LogError("Failed to import blocks: %s", e.what());
        return -1;
    }
    return 0;
}

snrxk_Block* snrxk_block_create(const void* raw_block, size_t raw_block_length)
{
    if (raw_block == nullptr && raw_block_length != 0) {
        return nullptr;
    }
    auto block{std::make_shared<CBlock>()};

    SpanReader stream{std::span{reinterpret_cast<const std::byte*>(raw_block), raw_block_length}};

    try {
        stream >> TX_WITH_WITNESS(*block);
    } catch (...) {
        LogDebug(BCLog::KERNEL, "Block decode failed.");
        return nullptr;
    }

    return snrxk_Block::create(block);
}

snrxk_Block* snrxk_block_copy(const snrxk_Block* block)
{
    return snrxk_Block::copy(block);
}

size_t snrxk_block_count_transactions(const snrxk_Block* block)
{
    return snrxk_Block::get(block)->vtx.size();
}

const snrxk_Transaction* snrxk_block_get_transaction_at(const snrxk_Block* block, size_t index)
{
    assert(index < snrxk_Block::get(block)->vtx.size());
    return snrxk_Transaction::ref(&snrxk_Block::get(block)->vtx[index]);
}

snrxk_BlockHeader* snrxk_block_get_header(const snrxk_Block* block)
{
    const auto& block_ptr = snrxk_Block::get(block);
    return snrxk_BlockHeader::create(static_cast<const CBlockHeader&>(*block_ptr));
}

int snrxk_block_to_bytes(const snrxk_Block* block, snrxk_WriteBytes writer, void* user_data)
{
    try {
        WriterStream ws{writer, user_data};
        ws << TX_WITH_WITNESS(*snrxk_Block::get(block));
        return 0;
    } catch (...) {
        return -1;
    }
}

snrxk_BlockHash* snrxk_block_get_hash(const snrxk_Block* block)
{
    return snrxk_BlockHash::create(snrxk_Block::get(block)->GetHash());
}

void snrxk_block_destroy(snrxk_Block* block)
{
    delete block;
}

snrxk_Block* snrxk_block_read(const snrxk_ChainstateManager* chainman, const snrxk_BlockTreeEntry* entry)
{
    auto block{std::make_shared<CBlock>()};
    if (!snrxk_ChainstateManager::get(chainman).m_chainman->m_blockman.ReadBlock(*block, snrxk_BlockTreeEntry::get(entry))) {
        LogError("Failed to read block.");
        return nullptr;
    }
    return snrxk_Block::create(block);
}

snrxk_BlockHeader* snrxk_block_tree_entry_get_block_header(const snrxk_BlockTreeEntry* entry)
{
    return snrxk_BlockHeader::create(snrxk_BlockTreeEntry::get(entry).GetBlockHeader());
}

int32_t snrxk_block_tree_entry_get_height(const snrxk_BlockTreeEntry* entry)
{
    return snrxk_BlockTreeEntry::get(entry).nHeight;
}

const snrxk_BlockHash* snrxk_block_tree_entry_get_block_hash(const snrxk_BlockTreeEntry* entry)
{
    return snrxk_BlockHash::ref(snrxk_BlockTreeEntry::get(entry).phashBlock);
}

int snrxk_block_tree_entry_equals(const snrxk_BlockTreeEntry* entry1, const snrxk_BlockTreeEntry* entry2)
{
    return &snrxk_BlockTreeEntry::get(entry1) == &snrxk_BlockTreeEntry::get(entry2);
}

snrxk_BlockHash* snrxk_block_hash_create(const unsigned char block_hash[32])
{
    return snrxk_BlockHash::create(std::span<const unsigned char>{block_hash, 32});
}

snrxk_BlockHash* snrxk_block_hash_copy(const snrxk_BlockHash* block_hash)
{
    return snrxk_BlockHash::copy(block_hash);
}

void snrxk_block_hash_to_bytes(const snrxk_BlockHash* block_hash, unsigned char output[32])
{
    std::memcpy(output, snrxk_BlockHash::get(block_hash).begin(), 32);
}

int snrxk_block_hash_equals(const snrxk_BlockHash* hash1, const snrxk_BlockHash* hash2)
{
    return snrxk_BlockHash::get(hash1) == snrxk_BlockHash::get(hash2);
}

void snrxk_block_hash_destroy(snrxk_BlockHash* hash)
{
    delete hash;
}

snrxk_BlockSpentOutputs* snrxk_block_spent_outputs_read(const snrxk_ChainstateManager* chainman, const snrxk_BlockTreeEntry* entry)
{
    auto block_undo{std::make_shared<CBlockUndo>()};
    if (snrxk_BlockTreeEntry::get(entry).nHeight < 1) {
        LogDebug(BCLog::KERNEL, "The genesis block does not have any spent outputs.");
        return snrxk_BlockSpentOutputs::create(block_undo);
    }
    if (!snrxk_ChainstateManager::get(chainman).m_chainman->m_blockman.ReadBlockUndo(*block_undo, snrxk_BlockTreeEntry::get(entry))) {
        LogError("Failed to read block spent outputs data.");
        return nullptr;
    }
    return snrxk_BlockSpentOutputs::create(block_undo);
}

snrxk_BlockSpentOutputs* snrxk_block_spent_outputs_copy(const snrxk_BlockSpentOutputs* block_spent_outputs)
{
    return snrxk_BlockSpentOutputs::copy(block_spent_outputs);
}

size_t snrxk_block_spent_outputs_count(const snrxk_BlockSpentOutputs* block_spent_outputs)
{
    return snrxk_BlockSpentOutputs::get(block_spent_outputs)->vtxundo.size();
}

const snrxk_TransactionSpentOutputs* snrxk_block_spent_outputs_get_transaction_spent_outputs_at(const snrxk_BlockSpentOutputs* block_spent_outputs, size_t transaction_index)
{
    assert(transaction_index < snrxk_BlockSpentOutputs::get(block_spent_outputs)->vtxundo.size());
    const auto* tx_undo{&snrxk_BlockSpentOutputs::get(block_spent_outputs)->vtxundo.at(transaction_index)};
    return snrxk_TransactionSpentOutputs::ref(tx_undo);
}

void snrxk_block_spent_outputs_destroy(snrxk_BlockSpentOutputs* block_spent_outputs)
{
    delete block_spent_outputs;
}

snrxk_TransactionSpentOutputs* snrxk_transaction_spent_outputs_copy(const snrxk_TransactionSpentOutputs* transaction_spent_outputs)
{
    return snrxk_TransactionSpentOutputs::copy(transaction_spent_outputs);
}

size_t snrxk_transaction_spent_outputs_count(const snrxk_TransactionSpentOutputs* transaction_spent_outputs)
{
    return snrxk_TransactionSpentOutputs::get(transaction_spent_outputs).vprevout.size();
}

void snrxk_transaction_spent_outputs_destroy(snrxk_TransactionSpentOutputs* transaction_spent_outputs)
{
    delete transaction_spent_outputs;
}

const snrxk_Coin* snrxk_transaction_spent_outputs_get_coin_at(const snrxk_TransactionSpentOutputs* transaction_spent_outputs, size_t coin_index)
{
    assert(coin_index < snrxk_TransactionSpentOutputs::get(transaction_spent_outputs).vprevout.size());
    const Coin* coin{&snrxk_TransactionSpentOutputs::get(transaction_spent_outputs).vprevout.at(coin_index)};
    return snrxk_Coin::ref(coin);
}

snrxk_Coin* snrxk_coin_copy(const snrxk_Coin* coin)
{
    return snrxk_Coin::copy(coin);
}

uint32_t snrxk_coin_confirmation_height(const snrxk_Coin* coin)
{
    return snrxk_Coin::get(coin).nHeight;
}

int snrxk_coin_is_coinbase(const snrxk_Coin* coin)
{
    return snrxk_Coin::get(coin).IsCoinBase() ? 1 : 0;
}

const snrxk_TransactionOutput* snrxk_coin_get_output(const snrxk_Coin* coin)
{
    return snrxk_TransactionOutput::ref(&snrxk_Coin::get(coin).out);
}

void snrxk_coin_destroy(snrxk_Coin* coin)
{
    delete coin;
}

int snrxk_chainstate_manager_process_block(
    snrxk_ChainstateManager* chainman,
    const snrxk_Block* block,
    int* _new_block)
{
    bool new_block;
    auto result = snrxk_ChainstateManager::get(chainman).m_chainman->ProcessNewBlock(snrxk_Block::get(block), /*force_processing=*/true, /*min_pow_checked=*/true, /*new_block=*/&new_block);
    if (_new_block) {
        *_new_block = new_block ? 1 : 0;
    }
    return result ? 0 : -1;
}

int snrxk_chainstate_manager_process_block_header(
    snrxk_ChainstateManager* chainstate_manager,
    const snrxk_BlockHeader* header,
    snrxk_BlockValidationState* state)
{
    try {
        auto& chainman = snrxk_ChainstateManager::get(chainstate_manager).m_chainman;
        auto result = chainman->ProcessNewBlockHeaders({&snrxk_BlockHeader::get(header), 1}, /*min_pow_checked=*/true, snrxk_BlockValidationState::get(state), /*ppindex=*/nullptr);

        return result ? 0 : -1;
    } catch (const std::exception& e) {
        LogError("Failed to process block header: %s", e.what());
        return -1;
    }
}

const snrxk_Chain* snrxk_chainstate_manager_get_active_chain(const snrxk_ChainstateManager* chainman)
{
    return snrxk_Chain::ref(&WITH_LOCK(snrxk_ChainstateManager::get(chainman).m_chainman->GetMutex(), return snrxk_ChainstateManager::get(chainman).m_chainman->ActiveChain()));
}

int snrxk_chain_get_height(const snrxk_Chain* chain)
{
    LOCK(::cs_main);
    return snrxk_Chain::get(chain).Height();
}

const snrxk_BlockTreeEntry* snrxk_chain_get_by_height(const snrxk_Chain* chain, int height)
{
    LOCK(::cs_main);
    return snrxk_BlockTreeEntry::ref(snrxk_Chain::get(chain)[height]);
}

int snrxk_chain_contains(const snrxk_Chain* chain, const snrxk_BlockTreeEntry* entry)
{
    LOCK(::cs_main);
    return snrxk_Chain::get(chain).Contains(&snrxk_BlockTreeEntry::get(entry)) ? 1 : 0;
}

snrxk_BlockHeader* snrxk_block_header_create(const void* raw_block_header, size_t raw_block_header_len)
{
    if (raw_block_header == nullptr && raw_block_header_len != 0) {
        return nullptr;
    }
    auto header{std::make_unique<CBlockHeader>()};
    SpanReader stream{std::span{reinterpret_cast<const std::byte*>(raw_block_header), raw_block_header_len}};

    try {
        stream >> *header;
    } catch (...) {
        LogError("Block header decode failed.");
        return nullptr;
    }

    return snrxk_BlockHeader::ref(header.release());
}

snrxk_BlockHeader* snrxk_block_header_copy(const snrxk_BlockHeader* header)
{
    return snrxk_BlockHeader::copy(header);
}

snrxk_BlockHash* snrxk_block_header_get_hash(const snrxk_BlockHeader* header)
{
    return snrxk_BlockHash::create(snrxk_BlockHeader::get(header).GetHash());
}

const snrxk_BlockHash* snrxk_block_header_get_prev_hash(const snrxk_BlockHeader* header)
{
    return snrxk_BlockHash::ref(&snrxk_BlockHeader::get(header).hashPrevBlock);
}

uint32_t snrxk_block_header_get_timestamp(const snrxk_BlockHeader* header)
{
    return snrxk_BlockHeader::get(header).nTime;
}

uint32_t snrxk_block_header_get_bits(const snrxk_BlockHeader* header)
{
    return snrxk_BlockHeader::get(header).nBits;
}

int32_t snrxk_block_header_get_version(const snrxk_BlockHeader* header)
{
    return snrxk_BlockHeader::get(header).nVersion;
}

uint32_t snrxk_block_header_get_nonce(const snrxk_BlockHeader* header)
{
    return snrxk_BlockHeader::get(header).nNonce;
}

void snrxk_block_header_destroy(snrxk_BlockHeader* header)
{
    delete header;
}
