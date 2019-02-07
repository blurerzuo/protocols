#ifndef _CANCELCIRCUIT_H_
#define _CANCELCIRCUIT_H_

#include "../Utils/Constants.h"
#include "../Utils/Data.h"
#include "../Gadgets/AccountGadgets.h"
#include "../Gadgets/TradingHistoryGadgets.h"

#include "../ThirdParty/BigInt.hpp"
#include "ethsnarks.hpp"
#include "utils.hpp"
#include "jubjub/point.hpp"
#include "jubjub/eddsa.hpp"
#include "gadgets/sha256_many.hpp"

using namespace ethsnarks;

namespace Loopring
{

class CancelGadget : public GadgetT
{
public:
    const VariableT tradingHistoryMerkleRoot;
    const VariableT accountsMerkleRoot;

    const jubjub::VariablePointT publicKey;

    VariableArrayT account;
    VariableArrayT orderID;
    libsnark::dual_variable_gadget<FieldT> padding;

    VariableT filled;
    VariableT cancelledBefore;
    VariableT cancelledAfter;

    VariableT walletID;
    VariableT token;
    VariableT balance;
    UpdateAccountGadget checkAccount;

    UpdateTradeHistoryGadget updateTradeHistory;

    // variables for signature
    const jubjub::VariablePointT sig_R;
    const VariableArrayT sig_s;
    const VariableArrayT sig_m;
    jubjub::PureEdDSA signatureVerifier;

    CancelGadget(
        ProtoboardT& pb,
        const jubjub::Params& params,
        const VariableT& _tradingHistoryMerkleRoot,
        const VariableT& _accountsMerkleRoot,
        const std::string& prefix
    ) :
        GadgetT(pb, prefix),

        tradingHistoryMerkleRoot(_tradingHistoryMerkleRoot),
        accountsMerkleRoot(_accountsMerkleRoot),

        publicKey(pb, FMT(prefix, ".publicKey")),

        account(make_var_array(pb, TREE_DEPTH_ACCOUNTS, FMT(prefix, ".account"))),
        orderID(make_var_array(pb, 4, FMT(prefix, ".orderID"))),
        padding(pb, 1, FMT(prefix, ".padding")),

        filled(make_variable(pb, 0, FMT(prefix, ".filled"))),
        cancelledBefore(make_variable(pb, 0, FMT(prefix, ".cancelledBefore"))),
        cancelledAfter(make_variable(pb, 0, FMT(prefix, ".cancelledAfter"))),
        updateTradeHistory(pb, tradingHistoryMerkleRoot, flatten({orderID, account}), filled, cancelledBefore, filled, cancelledAfter, FMT(prefix, ".updateTradeHistory")),

        walletID(make_variable(pb, FMT(prefix, ".walletID"))),
        token(make_variable(pb, FMT(prefix, ".token"))),
        balance(make_variable(pb, FMT(prefix, ".balance"))),
        checkAccount(pb, accountsMerkleRoot, account, publicKey, walletID, token, balance, balance, FMT(prefix, ".checkAccount")),

        sig_R(pb, FMT(prefix, ".R")),
        sig_s(make_var_array(pb, FieldT::size_in_bits(), FMT(prefix, ".s"))),
        sig_m(flatten({account, orderID, padding.bits})),
        signatureVerifier(pb, params, jubjub::EdwardsPoint(params.Gx, params.Gy), publicKey, sig_R, sig_s, sig_m, FMT(prefix, ".signatureVerifier"))
    {

    }

    const VariableT getNewTradingHistoryMerkleRoot() const
    {
        return updateTradeHistory.getNewTradingHistoryMerkleRoot();
    }

    const std::vector<VariableArrayT> getPublicData() const
    {
        return {account, orderID};
    }

    void generate_r1cs_witness(const Cancellation& cancellation)
    {
        pb.val(publicKey.x) = cancellation.publicKey.x;
        pb.val(publicKey.y) = cancellation.publicKey.y;

        account.fill_with_bits_of_field_element(pb, cancellation.account);
        orderID.fill_with_bits_of_field_element(pb, cancellation.orderID);

        padding.bits.fill_with_bits_of_field_element(pb, 0);
        padding.generate_r1cs_witness_from_bits();

        pb.val(filled) = cancellation.tradeHistoryUpdate.before.filled;
        pb.val(cancelledBefore) = cancellation.tradeHistoryUpdate.before.cancelled;
        pb.val(cancelledAfter) = cancellation.tradeHistoryUpdate.after.cancelled;

        pb.val(walletID) = cancellation.accountUpdate.before.walletID;
        pb.val(token) = cancellation.accountUpdate.before.token;
        pb.val(balance) = cancellation.accountUpdate.before.balance;

        updateTradeHistory.generate_r1cs_witness(cancellation.tradeHistoryUpdate.proof);

        checkAccount.generate_r1cs_witness(cancellation.accountUpdate.proof);

        pb.val(sig_R.x) = cancellation.signature.R.x;
        pb.val(sig_R.y) = cancellation.signature.R.y;
        sig_s.fill_with_bits_of_field_element(pb, cancellation.signature.s);
        signatureVerifier.generate_r1cs_witness();
    }

    void generate_r1cs_constraints()
    {
        padding.generate_r1cs_constraints(true);
        signatureVerifier.generate_r1cs_constraints();
        updateTradeHistory.generate_r1cs_constraints();
        checkAccount.generate_r1cs_constraints();
        pb.add_r1cs_constraint(ConstraintT(cancelledAfter, FieldT::one(), FieldT::one()), "cancelledAfter == 1");
    }
};

class CancelsCircuitGadget : public GadgetT
{
public:
    jubjub::Params params;

    unsigned int numCancels;
    std::vector<CancelGadget> cancels;

    libsnark::dual_variable_gadget<FieldT> publicDataHash;
    libsnark::dual_variable_gadget<FieldT> tradingHistoryMerkleRootBefore;
    libsnark::dual_variable_gadget<FieldT> tradingHistoryMerkleRootAfter;
    libsnark::dual_variable_gadget<FieldT> accountsMerkleRoot;

    std::vector<VariableArrayT> publicDataBits;
    VariableArrayT publicData;

    sha256_many* publicDataHasher;

    CancelsCircuitGadget(ProtoboardT& pb, const std::string& prefix) :
        GadgetT(pb, prefix),

        publicDataHash(pb, 256, FMT(prefix, ".publicDataHash")),

        tradingHistoryMerkleRootBefore(pb, 256, FMT(prefix, ".tradingHistoryMerkleRootBefore")),
        tradingHistoryMerkleRootAfter(pb, 256, FMT(prefix, ".tradingHistoryMerkleRootAfter")),
        accountsMerkleRoot(pb, 256, FMT(prefix, ".accountsMerkleRoot"))
    {
        this->publicDataHasher = nullptr;
    }

    ~CancelsCircuitGadget()
    {
        if (publicDataHasher)
        {
            delete publicDataHasher;
        }
    }

    void generate_r1cs_constraints(int numCancels)
    {
        this->numCancels = numCancels;

        pb.set_input_sizes(1);
        tradingHistoryMerkleRootBefore.generate_r1cs_constraints(true);
        publicDataBits.push_back(tradingHistoryMerkleRootBefore.bits);
        publicDataBits.push_back(tradingHistoryMerkleRootAfter.bits);
        for (size_t j = 0; j < numCancels; j++)
        {
            VariableT cancelTradingHistoryMerkleRoot = (j == 0) ? tradingHistoryMerkleRootBefore.packed : cancels.back().getNewTradingHistoryMerkleRoot();
            cancels.emplace_back(pb, params, cancelTradingHistoryMerkleRoot, accountsMerkleRoot.packed, std::string("cancels") + std::to_string(j));

            // Store data from withdrawal
            std::vector<VariableArrayT> ringPublicData = cancels.back().getPublicData();
            publicDataBits.insert(publicDataBits.end(), ringPublicData.begin(), ringPublicData.end());
        }

        publicDataHash.generate_r1cs_constraints(true);
        for (auto& cancel : cancels)
        {
            cancel.generate_r1cs_constraints();
        }

        // Check public data
        publicData = flattenReverse(publicDataBits);
        publicDataHasher = new sha256_many(pb, publicData, ".publicDataHash");
        publicDataHasher->generate_r1cs_constraints();

        // Check that the hash matches the public input
        /*for (unsigned int i = 0; i < 256; i++)
        {
            pb.add_r1cs_constraint(ConstraintT(publicDataHasher->result().bits[255-i], 1, publicDataHash.bits[i]), "publicData.check()");
        }*/

        // Make sure the merkle root afterwards is correctly passed in
        //pb.add_r1cs_constraint(ConstraintT(ringSettlements.back().getNewTradingHistoryMerkleRoot(), 1, tradingHistoryMerkleRootAfter.packed), "newMerkleRoot");
    }

    void printInfo()
    {
        std::cout << pb.num_constraints() << " constraints (" << (pb.num_constraints() / numCancels) << "/cancel)" << std::endl;
    }

    bool generateWitness(const std::vector<Loopring::Cancellation>& cancelsData,
                         const std::string& strTradingHistoryMerkleRootBefore, const std::string& strTradingHistoryMerkleRootAfter,
                         const std::string& strAccountsMerkleRoot)
    {
        ethsnarks::FieldT tradingHistoryMerkleRootBeforeValue = ethsnarks::FieldT(strTradingHistoryMerkleRootBefore.c_str());
        ethsnarks::FieldT tradingHistoryMerkleRootAfterValue = ethsnarks::FieldT(strTradingHistoryMerkleRootAfter.c_str());
        tradingHistoryMerkleRootBefore.bits.fill_with_bits_of_field_element(pb, tradingHistoryMerkleRootBeforeValue);
        tradingHistoryMerkleRootBefore.generate_r1cs_witness_from_bits();
        tradingHistoryMerkleRootAfter.bits.fill_with_bits_of_field_element(pb, tradingHistoryMerkleRootAfterValue);
        tradingHistoryMerkleRootAfter.generate_r1cs_witness_from_bits();

        ethsnarks::FieldT accountsMerkleRootValue = ethsnarks::FieldT(strAccountsMerkleRoot.c_str());
        accountsMerkleRoot.bits.fill_with_bits_of_field_element(pb, accountsMerkleRootValue);
        accountsMerkleRoot.generate_r1cs_witness_from_bits();

        for(unsigned int i = 0; i < cancelsData.size(); i++)
        {
            cancels[i].generate_r1cs_witness(cancelsData[i]);
        }

        publicDataHasher->generate_r1cs_witness();

        // Print out calculated hash of transfer data
        auto full_output_bits = publicDataHasher->result().get_digest();
        printBits("HashC: ", full_output_bits);
        BigInt publicDataHashDec = 0;
        for (unsigned int i = 0; i < full_output_bits.size(); i++)
        {
            publicDataHashDec = publicDataHashDec * 2 + (full_output_bits[i] ? 1 : 0);
        }
        std::cout << "publicDataHashDec: " << publicDataHashDec.to_string() << std::endl;
        libff::bigint<libff::alt_bn128_r_limbs> bn = libff::bigint<libff::alt_bn128_r_limbs>(publicDataHashDec.to_string().c_str());
        for (unsigned int i = 0; i < 256; i++)
        {
            pb.val(publicDataHash.bits[i]) = bn.test_bit(i);
        }
        publicDataHash.generate_r1cs_witness_from_bits();
        printBits("publicData: ", publicData.get_bits(pb));

        printBits("Public data bits: ", publicDataHash.bits.get_bits(pb));
        printBits("Hash bits: ", publicDataHasher->result().bits.get_bits(pb), true);

        return true;
    }
};

}

#endif
