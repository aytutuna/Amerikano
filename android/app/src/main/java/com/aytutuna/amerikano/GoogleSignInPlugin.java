package com.aytutuna.amerikano;

import androidx.core.content.ContextCompat;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

@CapacitorPlugin(name = "GoogleSignIn")
public class GoogleSignInPlugin extends Plugin {
    @PluginMethod
    public void signIn(PluginCall call) {
        String client = call.getString("clientId");
        String nonce = call.getString("nonce");
        if (client == null || nonce == null) {
            call.reject("clientId and nonce are required");
            return;
        }
        var option = new GetSignInWithGoogleOption.Builder(client).setNonce(nonce).build();
        var request = new GetCredentialRequest.Builder().addCredentialOption(option).build();
        CredentialManager.create(getContext()).getCredentialAsync(getActivity(), request, null,
            ContextCompat.getMainExecutor(getContext()),
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse result) {
                    var credential = result.getCredential();
                    if (credential instanceof CustomCredential
                        && GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) {
                        var out = new JSObject();
                        out.put("idToken", GoogleIdTokenCredential.createFrom(credential.getData()).getIdToken());
                        call.resolve(out);
                    } else {
                        call.reject("unexpected credential");
                    }
                }

                @Override
                public void onError(GetCredentialException e) {
                    call.reject(e instanceof GetCredentialCancellationException ? "cancelled" : e.getMessage(), e instanceof GetCredentialCancellationException ? "cancelled" : e.getType());
                }
            });
    }
}
